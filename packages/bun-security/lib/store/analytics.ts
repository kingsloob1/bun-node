/**
 * What every store's analytics operations check and encode the same way
 * (README §8, storage.md §3.1): events, counter rows and their dimensions,
 * counter queries and the tier a range reads, the event list's keyset
 * cursor, and rollup and retention arguments.
 *
 * A counter row's dimensions are stored as one canonical string, the
 * names sorted, each `name=value` percent-encoded and joined with `&`
 * (`action=block&route=POST%20%2Flogin`), so a row has one key whatever
 * order the dimensions were given in, and a partial match is a substring
 * test on `&name=value&`.
 */
import type {
  CounterQuery,
  CounterRow,
  EventFilter,
  EventListQuery,
  RetainedTable,
  SecurityEvent,
  Tier,
  TopKQuery,
} from "./types";
import { ConfigError } from "@kingsleyweb/bun-common";
import {
  decodePageCursor,
  encodePageCursor,
} from "@kingsleyweb/bun-sql/cursor";
import { jsonBody } from "./shared";
import {
  MAX_BATCH_COUNTERS,
  MAX_BATCH_EVENTS,
  MAX_PAGE_LIMIT,
  TIER_MS,
} from "./types";

/** The tiers, finest first. */
export const TIERS: readonly Tier[] = Object.freeze(["minute", "hour", "day"]);

/** The tables retention deletes from. */
export const RETAINED_TABLES: readonly RetainedTable[] = Object.freeze([
  "events",
  "minute",
  "hour",
  "day",
  "batches",
]);

/** The rollups a store makes: each tier into the next. */
export const ROLLUPS: readonly (readonly [Tier, Tier])[] = Object.freeze([
  ["minute", "hour"],
  ["hour", "day"],
] as const);

/** A rollup's watermark name in the store's state (`minute>hour`). */
export function watermarkName(from: Tier, to: Tier): string {
  return `${from}>${to}`;
}

/** The most a range read at minute resolution spans by default (README §8.3). */
const MINUTE_RANGE_MS = 6 * TIER_MS.hour;
/** The most a range read at hour resolution spans by default. */
const HOUR_RANGE_MS = 14 * TIER_MS.day;

/** A metric's name. */
const METRIC = /^[a-z0-9][a-z0-9._-]{0,99}$/;
/** A dimension's name. */
const DIM_NAME = /^\w{1,40}$/;
/** The most dimensions a row has. */
const MAX_DIMS = 8;
/** The longest dimension value. */
const MAX_DIM_VALUE = 200;
/** The longest id an event, a batch or a service may have. */
const MAX_EVENT_ID = 64;
/** The longest identifying field of an event (a route, a rule, a subject). */
const MAX_FIELD = 200;
/** The most rules an event lists. */
const MAX_EVENT_RULES = 50;
/** The most bytes an event's JSON may hold. */
export const MAX_EVENT_BYTES = 16 * 1024;

/** A bucket's start: `at` aligned down to `tier`. */
export function bucketOf(at: number, tier: Tier): number {
  return Math.floor(at / TIER_MS[tier]) * TIER_MS[tier];
}

/** The canonical form of a row's dimensions. */
export function dimsKey(
  dims: Readonly<Record<string, string>> | undefined,
): string {
  if (dims === undefined) return "";
  return Object.keys(dims)
    .sort()
    .map(
      (name) => `${encodeURIComponent(name)}=${encodeURIComponent(dims[name])}`,
    )
    .join("&");
}

/** The dimensions a canonical key holds. */
export function dimsOf(key: string): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  if (key === "") return Object.freeze(out);
  for (const part of key.split("&")) {
    const at = part.indexOf("=");
    out[decodeURIComponent(part.slice(0, at))] = decodeURIComponent(
      part.slice(at + 1),
    );
  }
  return Object.freeze(out);
}

/** The substrings a canonical key must hold, wrapped in `&`, for a partial match on `dims`. */
export function dimsNeedles(
  dims: Readonly<Record<string, string>> | undefined,
): string[] {
  if (dims === undefined) return [];
  return Object.keys(dims)
    .sort()
    .map(
      (name) =>
        `&${encodeURIComponent(name)}=${encodeURIComponent(dims[name])}&`,
    );
}

/** Whether a canonical key matches every needle. */
export function dimsMatch(key: string, needles: readonly string[]): boolean {
  const wrapped = `&${key}&`;
  return needles.every((needle) => wrapped.includes(needle));
}

/** Throws a `ConfigError` unless `value` is a usable dimension map. */
function checkDims(dims: unknown, what: string): void {
  if (dims === undefined) return;
  if (typeof dims !== "object" || dims === null || Array.isArray(dims)) {
    throw new ConfigError(
      `security store: ${what}'s dims must be an object of strings`,
    );
  }
  const entries = Object.entries(dims);
  if (entries.length > MAX_DIMS) {
    throw new ConfigError(
      `security store: ${what} has ${entries.length} dims; at most ${MAX_DIMS}`,
    );
  }
  for (const [name, value] of entries) {
    if (!DIM_NAME.test(name)) {
      throw new ConfigError(
        `security store: ${what}'s dim "${name}" must be 1 to 40 of letters, digits and _`,
      );
    }
    if (typeof value !== "string" || value.length > MAX_DIM_VALUE) {
      throw new ConfigError(
        `security store: ${what}'s dim "${name}" must be a string of at most ${MAX_DIM_VALUE} characters`,
      );
    }
  }
}

/** Throws a `ConfigError` unless `value` is epoch milliseconds. */
function checkTime(value: unknown, what: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ConfigError(
      `security store: ${what} must be epoch milliseconds`,
      {
        value,
      },
    );
  }
}

/** Throws a `ConfigError` unless `value` is a short, non-empty string. */
function checkText(
  value: unknown,
  what: string,
  max = MAX_FIELD,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new ConfigError(
      `security store: ${what} must be a string of 1 to ${max} characters`,
    );
  }
}

/** Throws a `ConfigError` unless `tier` is a {@link Tier}. */
export function checkTier(
  tier: unknown,
  what = "a tier",
): asserts tier is Tier {
  if (!TIERS.includes(tier as Tier)) {
    throw new ConfigError(
      `security store: ${what} is "minute", "hour" or "day", not "${String(tier)}"`,
    );
  }
}

/** A checked counter row, its bucket aligned and its dimensions canonical. */
export interface ResolvedCounter {
  /** The service. */
  readonly service: string;
  /** The tier. */
  readonly tier: Tier;
  /** The bucket's start. */
  readonly bucket: number;
  /** The metric. */
  readonly metric: string;
  /** The canonical dimensions. */
  readonly dims: string;
  /** What to add. */
  readonly value: number;
}

/** A resolved row's identity: its tier, service, metric, bucket and dimensions. */
export function counterKey(row: Omit<ResolvedCounter, "value">): string {
  return JSON.stringify([
    row.tier,
    row.service,
    row.metric,
    row.bucket,
    row.dims,
  ]);
}

/**
 * Checks counter rows and merges those with one identity (so one statement
 * never upserts a row twice); throws a `ConfigError` naming the first bad
 * row.
 */
export function resolveCounters(rows: unknown): ResolvedCounter[] {
  if (!Array.isArray(rows)) {
    throw new ConfigError("security store: counters must be a list of rows");
  }
  if (rows.length > MAX_BATCH_COUNTERS) {
    throw new ConfigError(
      `security store: at most ${MAX_BATCH_COUNTERS} counter rows a write, not ${rows.length}`,
    );
  }
  const merged = new Map<string, ResolvedCounter>();
  for (const [index, item] of (rows as unknown[]).entries()) {
    const what = `counter row ${index}`;
    if (typeof item !== "object" || item === null) {
      throw new ConfigError(`security store: ${what} must be an object`);
    }
    const row = item as Partial<CounterRow>;
    checkText(row.service, `${what}'s service`, MAX_EVENT_ID);
    const tier = row.tier ?? "minute";
    checkTier(tier, `${what}'s tier`);
    checkTime(row.at, `${what}'s at`);
    if (typeof row.metric !== "string" || !METRIC.test(row.metric)) {
      throw new ConfigError(
        `security store: ${what}'s metric must be 1 to 100 of a-z, 0-9, ".", "_" and "-", starting with a letter or digit`,
      );
    }
    checkDims(row.dims, what);
    if (!Number.isSafeInteger(row.value) || (row.value as number) < 0) {
      throw new ConfigError(
        `security store: ${what}'s value must be a non-negative whole number`,
      );
    }
    const resolved = {
      service: row.service,
      tier,
      bucket: bucketOf(row.at, tier),
      metric: row.metric,
      dims: dimsKey(row.dims),
      value: row.value as number,
    };
    const key = counterKey(resolved);
    const before = merged.get(key);
    merged.set(
      key,
      before === undefined
        ? resolved
        : { ...resolved, value: before.value + resolved.value },
    );
  }
  return [...merged.values()];
}

/**
 * The rows `rows` add to the tiers above their own whose buckets were
 * already rolled up: for each, the row again at the next tier while its
 * bucket there is below the rollup's watermark (README §8.3: a late batch
 * still reaches the hourly and daily rows).
 */
export function carryUp(
  rows: readonly ResolvedCounter[],
  watermark: (from: Tier, to: Tier) => number,
): ResolvedCounter[] {
  const out = new Map<string, ResolvedCounter>();
  const add = (row: ResolvedCounter): void => {
    const key = counterKey(row);
    const before = out.get(key);
    out.set(
      key,
      before === undefined ? row : { ...row, value: before.value + row.value },
    );
  };
  for (const row of rows) {
    add(row);
    let current = row;
    for (const [from, to] of ROLLUPS) {
      if (current.tier !== from) continue;
      if (current.bucket >= watermark(from, to)) break;
      current = { ...current, tier: to, bucket: bucketOf(current.bucket, to) };
      add(current);
    }
  }
  return [...out.values()];
}

/** Checks a batch id and its events; throws a `ConfigError` naming the first bad one. */
export function resolveEvents(
  batchId: unknown,
  events: unknown,
): SecurityEvent[] {
  checkText(batchId, "a batch id", MAX_FIELD);
  if (!Array.isArray(events)) {
    throw new ConfigError("security store: events must be a list");
  }
  if (events.length > MAX_BATCH_EVENTS) {
    throw new ConfigError(
      `security store: at most ${MAX_BATCH_EVENTS} events a batch, not ${events.length}`,
    );
  }
  return (events as unknown[]).map((item, index) => {
    const what = `event ${index}`;
    if (typeof item !== "object" || item === null) {
      throw new ConfigError(`security store: ${what} must be an object`);
    }
    const event = item as Partial<SecurityEvent>;
    checkText(event.id, `${what}'s id`, MAX_EVENT_ID);
    checkTime(event.at, `${what}'s at`);
    checkText(event.service, `${what}'s service`, MAX_EVENT_ID);
    checkText(event.action, `${what}'s action`, 40);
    for (const field of ["rule", "route", "country"] as const) {
      if (event[field] !== undefined)
        checkText(event[field], `${what}'s ${field}`);
    }
    if (event.rules !== undefined) {
      if (!Array.isArray(event.rules) || event.rules.length > MAX_EVENT_RULES) {
        throw new ConfigError(
          `security store: ${what}'s rules must be a list of at most ${MAX_EVENT_RULES}`,
        );
      }
      for (const rule of event.rules) checkText(rule, `${what}'s rules`);
    }
    if (event.subjects !== undefined) {
      if (typeof event.subjects !== "object" || event.subjects === null) {
        throw new ConfigError(
          `security store: ${what}'s subjects must be an object`,
        );
      }
      for (const [name, value] of Object.entries(event.subjects)) {
        if (!["ip", "user", "apiKey", "username"].includes(name)) {
          throw new ConfigError(
            `security store: ${what}'s subject "${name}" is not ip, user, apiKey or username`,
          );
        }
        if (value !== undefined) checkText(value, `${what}'s subject ${name}`);
      }
    }
    if (
      event.asn !== undefined &&
      (!Number.isSafeInteger(event.asn) || event.asn < 0)
    ) {
      throw new ConfigError(
        `security store: ${what}'s asn must be a whole number`,
      );
    }
    if (
      event.status !== undefined &&
      (!Number.isSafeInteger(event.status) ||
        event.status < 100 ||
        event.status > 999)
    ) {
      throw new ConfigError(
        `security store: ${what}'s status must be an HTTP status`,
      );
    }
    if (
      event.latencyMs !== undefined &&
      (typeof event.latencyMs !== "number" ||
        !Number.isFinite(event.latencyMs) ||
        event.latencyMs < 0)
    ) {
      throw new ConfigError(
        `security store: ${what}'s latencyMs must be a non-negative number`,
      );
    }
    if (event.dryRun !== undefined && typeof event.dryRun !== "boolean") {
      throw new ConfigError(
        `security store: ${what}'s dryRun must be a boolean`,
      );
    }
    const body = jsonBody(item, what) as SecurityEvent;
    if (JSON.stringify(body).length > MAX_EVENT_BYTES) {
      throw new ConfigError(
        `security store: ${what} is over ${MAX_EVENT_BYTES} bytes of JSON`,
      );
    }
    return Object.freeze(body);
  });
}

/** An event list's query, checked, with its defaults. */
export interface ResolvedEventQuery {
  /** The page size. */
  readonly limit: number;
  /** The cursor, if any. */
  readonly cursor: string | undefined;
  /** The direction. */
  readonly direction: "asc" | "desc";
  /** The filter. */
  readonly filter: EventFilter;
}

/** The filter fields, in a fixed order (the cursor's walk). */
const FILTER_FIELDS = [
  "service",
  "from",
  "to",
  "action",
  "rule",
  "route",
  "ip",
  "user",
  "apiKey",
  "username",
  "country",
  "asn",
  "dryRun",
] as const satisfies readonly (keyof EventFilter)[];

/** Checks an {@link EventListQuery}. */
export function resolveEventQuery(query: EventListQuery): ResolvedEventQuery {
  if (typeof query !== "object" || query === null) {
    throw new ConfigError("security store: an event query must be an object");
  }
  const { limit } = query;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new ConfigError(
      `security store: a page's limit must be a whole number from 1 to ${MAX_PAGE_LIMIT}`,
      { limit },
    );
  }
  const direction = query.direction ?? "desc";
  if (direction !== "asc" && direction !== "desc") {
    throw new ConfigError(
      `security store: a direction is "asc" or "desc", not "${String(direction)}"`,
    );
  }
  const filter: { -readonly [K in keyof EventFilter]: EventFilter[K] } = {};
  const writable = filter as Record<string, unknown>;
  for (const field of FILTER_FIELDS) {
    const value = query[field];
    if (value === undefined) continue;
    if (field === "from" || field === "to")
      checkTime(value, `the filter's ${field}`);
    else if (field === "asn") {
      if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new ConfigError(
          "security store: the filter's asn must be a whole number",
        );
      }
    } else if (field === "dryRun") {
      if (typeof value !== "boolean") {
        throw new ConfigError(
          "security store: the filter's dryRun must be a boolean",
        );
      }
    } else checkText(value, `the filter's ${field}`);
    writable[field] = value;
  }
  return {
    limit,
    cursor: query.cursor,
    direction,
    filter: Object.freeze(filter),
  };
}

/** An event list's cursor prefix (`se1.`) and kind. */
const EVENT_CURSOR = { prefix: "se1.", kind: "events" } as const;

/** The walk an event cursor is bound to: the direction and the filter. */
function eventWalk(query: ResolvedEventQuery): string[] {
  return [
    query.direction,
    ...FILTER_FIELDS.map((field) =>
      query.filter[field] === undefined
        ? ""
        : `${field}:${String(query.filter[field])}`,
    ),
  ];
}

/** The cursor after `last`. */
export function eventCursor(
  query: ResolvedEventQuery,
  last: SecurityEvent,
): string {
  return encodePageCursor(
    EVENT_CURSOR.prefix,
    EVENT_CURSOR.kind,
    eventWalk(query),
    [last.at, last.id],
  );
}

/** Where an event list's cursor stopped, or a `ConfigError` (another walk, malformed). */
export function eventPosition(
  query: ResolvedEventQuery,
): { readonly at: number; readonly id: string } | undefined {
  if (query.cursor === undefined) return undefined;
  const [at, id] = decodePageCursor(
    query.cursor,
    EVENT_CURSOR.prefix,
    EVENT_CURSOR.kind,
    eventWalk(query),
    ["number", "string"],
  );
  return { at: at as number, id: id as string };
}

/** Whether an event matches a filter (the memory store's test; the SQL stores' `WHERE`). */
export function eventMatches(
  event: SecurityEvent,
  filter: EventFilter,
): boolean {
  const subjects = event.subjects ?? {};
  return (
    (filter.service === undefined || event.service === filter.service) &&
    (filter.from === undefined || event.at >= filter.from) &&
    (filter.to === undefined || event.at < filter.to) &&
    (filter.action === undefined || event.action === filter.action) &&
    (filter.rule === undefined || event.rule === filter.rule) &&
    (filter.route === undefined || event.route === filter.route) &&
    (filter.ip === undefined || subjects.ip === filter.ip) &&
    (filter.user === undefined || subjects.user === filter.user) &&
    (filter.apiKey === undefined || subjects.apiKey === filter.apiKey) &&
    (filter.username === undefined || subjects.username === filter.username) &&
    (filter.country === undefined || event.country === filter.country) &&
    (filter.asn === undefined || event.asn === filter.asn) &&
    (filter.dryRun === undefined || (event.dryRun ?? false) === filter.dryRun)
  );
}

/** A counter query, checked, its tier chosen and its range aligned. */
export interface ResolvedCounterQuery {
  /** The service, or every one. */
  readonly service: string | undefined;
  /** The metric. */
  readonly metric: string;
  /** The tier read. */
  readonly tier: Tier;
  /** The first bucket read. */
  readonly from: number;
  /** The end of the range, exclusive. */
  readonly to: number;
  /** The partial match's needles. */
  readonly needles: readonly string[];
}

/** Checks a {@link CounterQuery}. */
export function resolveCounterQuery(query: CounterQuery): ResolvedCounterQuery {
  if (typeof query !== "object" || query === null) {
    throw new ConfigError("security store: a counter query must be an object");
  }
  if (query.service !== undefined)
    checkText(query.service, "the query's service", MAX_EVENT_ID);
  if (typeof query.metric !== "string" || !METRIC.test(query.metric)) {
    throw new ConfigError(
      "security store: the query's metric is not a metric name",
    );
  }
  checkTime(query.from, "the query's from");
  checkTime(query.to, "the query's to");
  if (query.to <= query.from) {
    throw new ConfigError(
      "security store: the query's to must be after its from",
    );
  }
  const span = query.to - query.from;
  const tier =
    query.tier ??
    (span <= MINUTE_RANGE_MS
      ? "minute"
      : span <= HOUR_RANGE_MS
        ? "hour"
        : "day");
  checkTier(tier, "the query's tier");
  checkDims(query.dims, "the query");
  return {
    service: query.service,
    metric: query.metric,
    tier,
    from: bucketOf(query.from, tier),
    to: query.to,
    needles: dimsNeedles(query.dims),
  };
}

/** Checks a top-K's limit. */
export function checkTopKLimit(query: TopKQuery): number {
  if (
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > MAX_PAGE_LIMIT
  ) {
    throw new ConfigError(
      `security store: a top-K's limit must be a whole number from 1 to ${MAX_PAGE_LIMIT}`,
    );
  }
  return query.limit;
}

/** Checks a rollup's arguments; answers `until` aligned down to the target tier. */
export function checkRollup(
  from: unknown,
  to: unknown,
  until: unknown,
): number {
  if (!ROLLUPS.some(([a, b]) => a === from && b === to)) {
    throw new ConfigError(
      `security store: a rollup is minute to hour or hour to day, not ${String(from)} to ${String(to)}`,
    );
  }
  checkTime(until, "a rollup's until");
  return bucketOf(until, to as Tier);
}

/** Checks a retention delete's arguments. */
export function checkDeleteBefore(
  table: unknown,
  before: unknown,
  limit: unknown,
): void {
  if (!RETAINED_TABLES.includes(table as RetainedTable)) {
    throw new ConfigError(
      `security store: retention deletes from ${RETAINED_TABLES.join(", ")}, not "${String(table)}"`,
    );
  }
  checkTime(before, "deleteBefore()'s before");
  if (
    !Number.isSafeInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > 10_000
  ) {
    throw new ConfigError(
      "security store: deleteBefore()'s limit must be a whole number from 1 to 10,000",
    );
  }
}

/** The watermark a retention delete of a counter tier may not pass: the next tier's rollup of it. */
export function retentionFloor(
  table: RetainedTable,
): readonly [Tier, Tier] | undefined {
  return table === "minute"
    ? ["minute", "hour"]
    : table === "hour"
      ? ["hour", "day"]
      : undefined;
}
