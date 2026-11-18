/**
 * The events list's filters (ui.md §7, "Events list"), as the URL holds
 * them: each under the API's own query name, so a link names exactly the
 * page the sender saw. Also what a live `event` message is matched against
 * for the "N new" chip, the query keys (a list's starts with `eventsList`,
 * so live messages never reshuffle it) and the event's types.
 */
import type { Routes } from "../../api/routes.gen";

/** An event as `GET /analytics/events` returns it. */
export type EventDto =
  Routes["GET /analytics/events"]["responses"][200]["items"][number];

/** A page of events. */
export type EventPageDto = Routes["GET /analytics/events"]["responses"][200];

/** One event, whole (`GET /analytics/events/:id`). */
export type EventDetailDto =
  Routes["GET /analytics/events/:id"]["responses"][200];

/** The actions an event can carry, least severe first (bun-security's `SecurityAction`). */
export const EVENT_ACTIONS = [
  "allow",
  "log",
  "tag",
  "delay",
  "challenge",
  "block",
  "ban",
  "drop",
] as const;

/** The fields a form may offer. */
export type FilterField =
  | "time"
  | "action"
  | "rule"
  | "route"
  | "ip"
  | "country"
  | "asn"
  | "dryRun"
  | "accounts";

/** Every field, in order (the events list's form). */
export const ALL_FILTER_FIELDS: readonly FilterField[] = [
  "time",
  "action",
  "rule",
  "route",
  "ip",
  "country",
  "asn",
  "dryRun",
  "accounts",
];

/** The filters, as the URL holds them (empty: not filtered). */
export interface EventFilters {
  /** Events at or after, epoch ms. */
  readonly from: number | undefined;
  /** Events before, epoch ms. */
  readonly to: number | undefined;
  /** The action. */
  readonly action: string;
  /** The deciding rule. */
  readonly rule: string;
  /** The route's key (`POST /login`). */
  readonly route: string;
  /** The address key. */
  readonly ip: string;
  /** The country, ISO 3166-1 alpha-2. */
  readonly country: string;
  /** The autonomous system number. */
  readonly asn: number | undefined;
  /** Dry-run hits only (`true`), enforced only (`false`), or both. */
  readonly dryRun: boolean | undefined;
  /** A user's key (needs `events:read`). */
  readonly user: string;
  /** An API key's key (needs `events:read`). */
  readonly apiKey: string;
  /** An attempted username's key (needs `events:read`). */
  readonly username: string;
}

/** The text filters (each a string in the URL and the API's query). */
export const TEXT_FILTERS = [
  "action",
  "rule",
  "route",
  "ip",
  "country",
  "user",
  "apiKey",
  "username",
] as const;

/** The filters that name an account: they need `events:read`. */
export const ACCOUNT_FILTERS = ["user", "apiKey", "username"] as const;

/** Every URL parameter a filter lives in. */
export const FILTER_PARAMS = [
  "from",
  "to",
  "asn",
  "dryRun",
  ...TEXT_FILTERS,
] as const;

/** A filter's name. */
export type FilterName = (typeof FILTER_PARAMS)[number];

/** A whole non-negative number from a URL value, else `undefined`. */
function wholeOf(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

/** The filters in `search` (a URL query); a malformed value is no filter. */
export function filtersOf(search: string): EventFilters {
  const params = new URLSearchParams(search);
  const text = (name: (typeof TEXT_FILTERS)[number]) =>
    (params.get(name) ?? "").trim();
  const dryRun = params.get("dryRun");
  return {
    from: wholeOf(params.get("from")),
    to: wholeOf(params.get("to")),
    asn: wholeOf(params.get("asn")),
    dryRun: dryRun === "true" ? true : dryRun === "false" ? false : undefined,
    action: text("action"),
    rule: text("rule"),
    route: text("route"),
    ip: text("ip"),
    country: text("country"),
    user: text("user"),
    apiKey: text("apiKey"),
    username: text("username"),
  };
}

/** The filters as URL values (empty ones left out), in {@link FILTER_PARAMS}' order. */
export function filterParams(filters: EventFilters): [FilterName, string][] {
  const out: [FilterName, string][] = [];
  if (filters.from !== undefined) out.push(["from", String(filters.from)]);
  if (filters.to !== undefined) out.push(["to", String(filters.to)]);
  if (filters.asn !== undefined) out.push(["asn", String(filters.asn)]);
  if (filters.dryRun !== undefined)
    out.push(["dryRun", String(filters.dryRun)]);
  for (const name of TEXT_FILTERS) {
    if (filters[name] !== "") out.push([name, filters[name]]);
  }
  return out;
}

/** Whether any filter is set. */
export function anyFilter(filters: EventFilters): boolean {
  return filterParams(filters).length > 0;
}

/** Whether an account filter is set. */
export function anyAccountFilter(filters: EventFilters): boolean {
  return ACCOUNT_FILTERS.some((name) => filters[name] !== "");
}

/** `GET /analytics/events`' query for `filters` (empty ones left out). */
export function listQuery(
  filters: EventFilters,
): Omit<
  Routes["GET /analytics/events"]["query"],
  "scope" | "limit" | "cursor" | "direction"
> {
  return {
    ...(filters.from === undefined ? {} : { from: filters.from }),
    ...(filters.to === undefined ? {} : { to: filters.to }),
    ...(filters.asn === undefined ? {} : { asn: filters.asn }),
    ...(filters.dryRun === undefined ? {} : { dryRun: filters.dryRun }),
    ...Object.fromEntries(
      TEXT_FILTERS.filter((name) => filters[name] !== "").map((name) => [
        name,
        filters[name],
      ]),
    ),
  };
}

/** `search` with `filters` in place of the filters it held, back on the first page. */
export function searchWith(search: string, filters: EventFilters): string {
  const params = new URLSearchParams(search);
  for (const name of FILTER_PARAMS) params.delete(name);
  // Another filter's cursor means nothing: the walk starts again.
  params.delete("page");
  for (const [name, value] of filterParams(filters)) params.set(name, value);
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

/** The event a live `event` message carries (`{ topic, epoch, seq, event }`), or `null`. */
export function liveEventOf(data: unknown): EventDto | null {
  if (typeof data !== "object" || data === null) return null;
  const event = (data as { event?: unknown }).event;
  if (typeof event !== "object" || event === null) return null;
  const candidate = event as Partial<EventDto>;
  return typeof candidate.id === "string" &&
    typeof candidate.at === "number" &&
    typeof candidate.action === "string"
    ? (event as EventDto)
    : null;
}

/**
 * Whether `event` passes `filters`, as far as the event tells: a field it
 * does not carry fails a filter on that field (the list would not show it
 * either).
 */
export function matchesFilters(
  event: EventDto,
  filters: EventFilters,
): boolean {
  if (filters.from !== undefined && event.at < filters.from) return false;
  if (filters.to !== undefined && event.at >= filters.to) return false;
  if (filters.asn !== undefined && event.asn !== filters.asn) return false;
  if (
    filters.dryRun !== undefined &&
    (event.dryRun === true) !== filters.dryRun
  )
    return false;
  const fields: Record<(typeof TEXT_FILTERS)[number], string | undefined> = {
    action: event.action,
    rule: event.rule,
    route: event.route,
    ip: event.subjects?.ip,
    country: event.country,
    user: event.subjects?.user,
    apiKey: event.subjects?.apiKey,
    username: event.subjects?.username,
  };
  return TEXT_FILTERS.every(
    (name) => filters[name] === "" || fields[name] === filters[name],
  );
}

/** The events screens' query keys. */
export const eventKeys = {
  /** A page of the events list (live messages never invalidate it: the chip refetches it). */
  list: (
    scope: string,
    filters: EventFilters,
    cursor: string | undefined,
    limit: number,
  ) => ["eventsList", scope, "events", filters, cursor ?? null, limit] as const,
  /** Every page of a scope's event lists (the chip's refetch). */
  lists: (scope: string) => ["eventsList", scope] as const,
  /** A page of the automatic bans (ban events). */
  autoBans: (
    scope: string,
    filters: EventFilters,
    cursor: string | undefined,
    limit: number,
  ) =>
    ["eventsList", scope, "autoBans", filters, cursor ?? null, limit] as const,
  /** One event, whole. */
  detail: (id: string) => ["eventDetail", id] as const,
};

/** A time as people read it. */
export function when(at: number): string {
  return new Date(at).toLocaleString();
}

/** What a ban event without a rule is grouped under. */
export const NO_RULE = "(no rule)";

/** Events counted per rule, most first (ties by name). */
export function countByRule(
  items: readonly EventDto[],
): { rule: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const event of items) {
    const rule = event.rule ?? NO_RULE;
    counts.set(rule, (counts.get(rule) ?? 0) + 1);
  }
  return [...counts]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));
}
