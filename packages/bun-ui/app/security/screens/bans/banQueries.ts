/** The bans screens' query keys and filters (URL parameters). */
import type { Routes } from "../../api/routes.gen";

/** A ban as the API returns it. */
export type BanDto = Routes["GET /bans"]["responses"][200]["items"][number];

/** The list's filters, as the URL holds them. */
export interface BanFilters {
  /** `active` (the default), `past` or `all`. */
  readonly state: "active" | "past" | "all";
  /** The subject's kind, or empty for any. */
  readonly kind: "" | "ip" | "cidr" | "user" | "apiKey";
  /** The source, or empty for any. */
  readonly source: "" | "manual" | "auto";
  /** The rule, or empty. */
  readonly rule: string;
  /** An address, a range or an account key, or empty. */
  readonly search: string;
  /** The order. */
  readonly sort: "created" | "expires";
  /** The direction. */
  readonly direction: "asc" | "desc";
}

/** The URL parameters the filters live in. */
export const FILTER_PARAMS = [
  "state",
  "kind",
  "source",
  "rule",
  "search",
  "sort",
  "direction",
] as const;

/** The filters in `search` (a URL query), defaulted. */
export function filtersOf(search: string): BanFilters {
  const params = new URLSearchParams(search);
  const pick = <T extends string>(
    name: string,
    allowed: readonly T[],
    fallback: T,
  ): T => {
    const value = params.get(name);
    return value !== null && (allowed as readonly string[]).includes(value)
      ? (value as T)
      : fallback;
  };
  return {
    state: pick("state", ["active", "past", "all"], "active"),
    kind: pick("kind", ["", "ip", "cidr", "user", "apiKey"], ""),
    source: pick("source", ["", "manual", "auto"], ""),
    rule: params.get("rule") ?? "",
    search: params.get("search") ?? "",
    sort: pick("sort", ["created", "expires"], "created"),
    direction: pick("direction", ["asc", "desc"], "desc"),
  };
}

/** The list query's parameters for `filters` (empty ones left out). */
export function listQuery(filters: BanFilters): {
  active?: boolean;
  kind?: "ip" | "cidr" | "user" | "apiKey";
  source?: "manual" | "auto";
  rule?: string;
  search?: string;
  sort: "created" | "expires";
  direction: "asc" | "desc";
} {
  return {
    ...(filters.state === "all" ? {} : { active: filters.state === "active" }),
    ...(filters.kind === "" ? {} : { kind: filters.kind }),
    ...(filters.source === "" ? {} : { source: filters.source }),
    ...(filters.rule.trim() === "" ? {} : { rule: filters.rule.trim() }),
    ...(filters.search.trim() === "" ? {} : { search: filters.search.trim() }),
    sort: filters.sort,
    direction: filters.direction,
  };
}

/** The bans screens' query keys; the list's starts with `bansList`, so live messages never reshuffle it. */
export const banKeys = {
  /** A page of the list. */
  list: (
    scope: string,
    filters: BanFilters,
    cursor: string | undefined,
    limit: number,
  ) => ["bansList", scope, filters, cursor ?? null, limit] as const,
  /** Whether any automatic ban exists (the source filter offers it then). */
  autoExists: (scope: string) => ["bans", "autoExists", scope] as const,
  /** One ban's detail. */
  detail: (id: string) => ["bans", "detail", id] as const,
};

/** A time as people read it. */
export function when(at: number | null): string {
  return at === null ? "never" : new Date(at).toLocaleString();
}
