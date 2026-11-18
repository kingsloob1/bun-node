/**
 * The lists' filters and search, kept in the URL (ui.md §5: a shared link
 * shows what the sender saw): `kind`, `action`, `expiry`, `origin`, `q`,
 * and the page (`page`, 1-based) and its size (`limit`). The list is the
 * policy's, already in the browser, so all of it is done here — the search
 * included: an address finds the CIDR entries containing it.
 */
import type { EntryKind, ListAction, ListEntryDto } from "./entries";
import { cidrContains, isAddress, parseCidr } from "../../components/cidr";
import {
  entryKind,
  isExpired,
  KIND_LABELS,
  LIST_ACTIONS,
  shownValue,
} from "./entries";

/** The expiry filter's choices. */
export type ExpiryFilter = "" | "expiring" | "permanent" | "expired";

/** The origin filter's choices. */
export type OriginFilter = "" | "own" | "inherited";

/** The URL parameters. */
export const FILTER_PARAMS = [
  "kind",
  "action",
  "expiry",
  "origin",
  "q",
] as const;

/** The page parameters. */
export const PAGE_PARAM = "page";
export const LIMIT_PARAM = "limit";

/** The default page size. */
export const DEFAULT_LIMIT = 50;

/** The page sizes offered. */
export const PAGE_SIZES: readonly number[] = [10, 20, 50, 100, 200];

/** The filters in force. */
export interface ListFilters {
  /** The kind, or `""` for every kind. */
  readonly kind: EntryKind | "";
  /** The action, or `""` for every action. */
  readonly action: ListAction | "";
  /** The expiry, or `""` for any. */
  readonly expiry: ExpiryFilter;
  /** The origin, or `""` for both. */
  readonly origin: OriginFilter;
  /** The search text. */
  readonly q: string;
}

/** The filters in `search`; an unknown value is no filter. */
export function readFilters(search: string): ListFilters {
  const params = new URLSearchParams(search);
  const kind = params.get("kind") ?? "";
  const action = params.get("action") ?? "";
  const expiry = params.get("expiry") ?? "";
  const origin = params.get("origin") ?? "";
  return {
    kind: kind in KIND_LABELS ? (kind as EntryKind) : "",
    action: (LIST_ACTIONS as readonly string[]).includes(action)
      ? (action as ListAction)
      : "",
    expiry: ["expiring", "permanent", "expired"].includes(expiry)
      ? (expiry as ExpiryFilter)
      : "",
    origin: ["own", "inherited"].includes(origin)
      ? (origin as OriginFilter)
      : "",
    q: params.get("q") ?? "",
  };
}

/** The page and size in `search`: page 1, the default size, unless it names others. */
export function readPage(search: string): { page: number; limit: number } {
  const params = new URLSearchParams(search);
  const page = Number(params.get(PAGE_PARAM));
  const limit = Number(params.get(LIMIT_PARAM));
  return {
    page: Number.isInteger(page) && page > 0 ? page : 1,
    limit:
      Number.isInteger(limit) && limit > 0
        ? Math.min(limit, PAGE_SIZES.at(-1)!)
        : DEFAULT_LIMIT,
  };
}

/** Whether `entry` matches the search text. */
export function matchesSearch(entry: ListEntryDto, q: string): boolean {
  const text = q.trim();
  if (text === "") return true;
  // An address: the entries naming it, or a range containing it.
  if (isAddress(text) && entry.ip !== undefined) {
    const address = parseCidr(text)!;
    const range = parseCidr(entry.ip);
    return range !== null && cidrContains(range, address);
  }
  const value = shownValue(entry);
  return (
    value !== undefined && value.toLowerCase().includes(text.toLowerCase())
  );
}

/** A row of the list: an entry and where it comes from. */
export interface ListRow {
  /** The entry. */
  readonly entry: ListEntryDto;
  /** The scope it was written in (`global`, `group:<id>`, `service:<id>`). */
  readonly origin: string;
  /** Whether it is the scope's own (editable) entry. */
  readonly own: boolean;
}

/** The rows matching `filters` at `now`. */
export function applyFilters(
  rows: readonly ListRow[],
  filters: ListFilters,
  now: number,
): ListRow[] {
  return rows.filter(({ entry, own }) => {
    if (filters.kind !== "" && entryKind(entry) !== filters.kind) return false;
    if (filters.action !== "" && entry.action !== filters.action) return false;
    if (filters.origin === "own" && !own) return false;
    if (filters.origin === "inherited" && own) return false;
    if (filters.expiry !== "") {
      const expired = isExpired(entry, now);
      if (filters.expiry === "expired" && !expired) return false;
      if (filters.expiry === "permanent" && entry.expiresAt !== undefined)
        return false;
      if (
        filters.expiry === "expiring" &&
        (entry.expiresAt === undefined || expired)
      )
        return false;
    }
    return matchesSearch(entry, filters.q);
  });
}
