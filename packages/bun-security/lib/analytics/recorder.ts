/**
 * An enforcement point's analytics counters (README §8.1): every decision
 * counted into per-minute rows, refusals counted exactly per subject per
 * day, and the heaviest subjects of each minute kept by space-saving, all
 * in bounded memory. `flush()` answers the rows of the minutes that have
 * closed, as `CounterRow`s a store adds (`addCounters`, or with a batch of
 * events in `appendEvents`); rows from several enforcement points add up.
 *
 * Nothing is dropped silently: a value past a bound is counted under
 * `(other)`, and the overflow itself under `analytics.overflow`.
 */
import type { Decision, SubjectKeys } from "../engine/decision";
import type { CounterRow } from "../store/types";
import { ConfigError } from "@kingsleyweb/bun-common";
import { resolveCounters } from "../store/analytics";
import { scrubRule } from "./scrub";
import { SpaceSaving } from "./spaceSaving";

/** The longest dimension value a store takes; a longer one is cut, ending in `…`. */
const MAX_DIM_VALUE = 200;

/** `value` cut to a dimension's length. */
function fit(value: string): string {
  return value.length <= MAX_DIM_VALUE
    ? value
    : `${value.slice(0, MAX_DIM_VALUE - 1)}…`;
}

/** The subject kinds counted per subject (README §8.1's subject keys). */
export type AnalyticsSubjectKind = "ip" | "apiKey" | "username" | "user";

/** The actions that refuse a request: counted exactly per subject. */
export const REFUSING_ACTIONS: readonly string[] = Object.freeze([
  "block",
  "ban",
  "drop",
]);

/** The decision-latency histogram's bucket bounds, milliseconds (`le`), then `+Inf`. */
export const LATENCY_BUCKETS_MS: readonly number[] = Object.freeze([
  0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100,
]);

/** The value a bound folds the rest into. */
export const OTHER = "(other)";

/** The metrics the recorder writes (README §8.1). */
export const ANALYTICS_METRICS = Object.freeze({
  /** Requests by action: `{ action }`. */
  requests: "requests",
  /** Requests by route and action: `{ route, action }`. */
  routes: "requests.route",
  /** Rule hits: `{ rule, action, dryRun }` (`action` is what it did or, in dry run, would have done). */
  rules: "rules",
  /** Requests by country and action: `{ country, action }`. */
  countries: "requests.country",
  /** Requests by autonomous system and action: `{ asn, action }`. */
  asns: "requests.asn",
  /** Answers by status class: `{ class }` (`2xx` … `5xx`). */
  responses: "responses",
  /** The decision latency histogram: `{ le }`, cumulative-free (each bucket its own count). */
  latency: "latency",
  /** Exact refusals per subject, day tier: `{ kind, subject }`. */
  refused: "refused",
  /** The minute's most refused subjects, by space-saving: `{ kind, subject }`. */
  topRefused: "top.refused",
  /** The minute's busiest subjects, by space-saving: `{ kind, subject }`. */
  topRequests: "top.requests",
  /** Values folded into `(other)` by a bound: `{ what }`. */
  overflow: "analytics.overflow",
} as const);

/** One decision to count. */
export interface AnalyticsRecord {
  /** When it was decided, epoch milliseconds. Default: the recorder's clock. */
  readonly at?: number;
  /** The action taken. */
  readonly action: string;
  /** The rules hit: what each did, and whether it was in dry run. */
  readonly hits?: readonly {
    /** The rule's id. */
    readonly rule: string;
    /** What it did, or in dry run would have done. */
    readonly action: string;
    /** Whether it was in dry run. */
    readonly dryRun?: boolean;
  }[];
  /** The route's key (`POST /login`), when known. */
  readonly route?: string;
  /** The subjects it was decided under. */
  readonly subject?: SubjectKeys;
  /** The client's country, when known. */
  readonly country?: string;
  /** The client's autonomous system number, when known. */
  readonly asn?: number;
  /** How long the decision took, milliseconds. */
  readonly latencyMs?: number;
  /** The status it was answered with, when known. */
  readonly status?: number;
}

/** What {@link AnalyticsRecorder.recordDecision} takes beside the decision. */
export type DecisionExtras = Omit<
  AnalyticsRecord,
  "action" | "hits" | "subject"
>;

/** Options of {@link createAnalyticsRecorder}. */
export interface AnalyticsRecorderOptions {
  /** The service counted: every row's `service`. */
  readonly service: string;
  /** The clock, epoch milliseconds. Default `Date.now`. */
  readonly now?: () => number;
  /**
   * The subject kinds counted per subject. Default `["ip", "apiKey",
   * "username"]`: the address key, and the API key's and the username's
   * HMAC, as the engine keys them. `user` counts the user id's HMAC, as the
   * engine keys it too.
   */
  readonly subjects?: readonly AnalyticsSubjectKind[];
  /** How many subjects each minute's top-K holds per metric and kind. Default 100 (README §8.1). */
  readonly topK?: number;
  /** How many rows one minute may hold, every metric together; past it, `(other)`. Default 2,000 (README §8.5). */
  readonly maxRowsPerMinute?: number;
  /** How many autonomous systems one minute counts by name; past it, `(other)`. Default 200 (README §8.1). */
  readonly maxAsns?: number;
  /** How many subjects the exact refusal counts hold between flushes; past it, `(other)`. Default 50,000. */
  readonly maxRefusedSubjects?: number;
  /** How many minutes may wait for a flush; past it, the oldest is dropped and counted. Default 60. */
  readonly maxPendingMinutes?: number;
}

/** What the recorder holds now. */
export interface AnalyticsRecorderStats {
  /** The minutes not yet flushed. */
  readonly pendingMinutes: number;
  /** The rows they hold. */
  readonly pendingRows: number;
  /** The subjects of the exact refusal counts not yet flushed. */
  readonly pendingRefused: number;
}

/** An enforcement point's counters; see the module's description. */
export interface AnalyticsRecorder {
  /** Counts one decision. */
  readonly record: (record: AnalyticsRecord) => void;
  /** Counts an engine decision: its action, hits and subject, with what the caller knows beside. */
  readonly recordDecision: (
    decision: Decision,
    extras?: DecisionExtras,
  ) => void;
  /** Adds to any metric of the minute (`store.errors`, `events.dropped`). */
  readonly count: (
    metric: string,
    dims?: Readonly<Record<string, string>>,
    value?: number,
    at?: number,
  ) => void;
  /** The rows of every closed minute, and the exact refusal counts so far; `all` flushes the open minute too. */
  readonly flush: (options?: { readonly all?: boolean }) => CounterRow[];
  /** What it holds now. */
  readonly stats: () => AnalyticsRecorderStats;
}

/** A minute: its rows by identity, and its top-K summaries. */
interface Minute {
  /** The rows, by metric and canonical dims. */
  readonly rows: Map<
    string,
    { metric: string; dims: Record<string, string>; value: number }
  >;
  /** The ASNs counted by name. */
  readonly asns: Set<string>;
  /** Each top-K summary, by metric and kind. */
  readonly tops: Map<string, SpaceSaving>;
}

/** A minute's start. */
function minuteOf(at: number): number {
  return Math.floor(at / 60_000) * 60_000;
}

/** A day's start. */
function dayOf(at: number): number {
  return Math.floor(at / 86_400_000) * 86_400_000;
}

/** A row's identity within a minute. */
function rowKey(
  metric: string,
  dims: Readonly<Record<string, string>>,
): string {
  return `${metric}\u0000${Object.keys(dims)
    .sort()
    .map((name) => `${name}=${dims[name]}`)
    .join("\u0000")}`;
}

/** Checks a positive whole option. */
function positive(
  value: number | undefined,
  fallback: number,
  what: string,
): number {
  const out = value ?? fallback;
  if (!Number.isSafeInteger(out) || out < 1) {
    throw new ConfigError(
      `createAnalyticsRecorder(): ${what} must be a positive whole number`,
    );
  }
  return out;
}

/** A status's class (`4xx`), or `undefined` for a value that is not a status. */
function statusClass(status: number | undefined): string | undefined {
  return status !== undefined &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
    ? `${Math.floor(status / 100)}xx`
    : undefined;
}

/** The histogram bucket of a latency. */
function latencyBucket(ms: number): string {
  for (const bound of LATENCY_BUCKETS_MS) if (ms <= bound) return String(bound);
  return "+Inf";
}

/** An enforcement point's counters; see the module's description. */
export function createAnalyticsRecorder(
  options: AnalyticsRecorderOptions,
): AnalyticsRecorder {
  if (typeof options !== "object" || options === null) {
    throw new ConfigError(
      "createAnalyticsRecorder(): options must be { service, … }",
    );
  }
  const { service } = options;
  if (
    typeof service !== "string" ||
    service.length === 0 ||
    service.length > 64
  ) {
    throw new ConfigError(
      "createAnalyticsRecorder(): service must be 1 to 64 characters",
    );
  }
  const now = options.now ?? Date.now;
  const kinds = options.subjects ?? ["ip", "apiKey", "username"];
  for (const kind of kinds) {
    if (!["ip", "apiKey", "username", "user"].includes(kind)) {
      throw new ConfigError(
        `createAnalyticsRecorder(): "${String(kind)}" is not a subject kind (ip, apiKey, username, user)`,
      );
    }
  }
  const topK = positive(options.topK, 100, "topK");
  const maxRows = positive(options.maxRowsPerMinute, 2_000, "maxRowsPerMinute");
  const maxAsns = positive(options.maxAsns, 200, "maxAsns");
  const maxRefused = positive(
    options.maxRefusedSubjects,
    50_000,
    "maxRefusedSubjects",
  );
  const maxPending = positive(
    options.maxPendingMinutes,
    60,
    "maxPendingMinutes",
  );

  const minutes = new Map<number, Minute>();
  /** Exact refusals, by day, then `kind\0subject`. */
  const refused = new Map<number, Map<string, number>>();
  let refusedSize = 0;
  /** Overflow counted since the last flush, by what overflowed, and the minute it was in. */
  const overflow = new Map<string, { at: number; value: number }>();

  const countOverflow = (what: string, at: number, value = 1): void => {
    const before = overflow.get(what);
    overflow.set(what, {
      at: before?.at ?? at,
      value: (before?.value ?? 0) + value,
    });
  };

  /** The minute of `at`, opened if new; the oldest dropped past the bound. */
  const minuteFor = (at: number): Minute => {
    const start = minuteOf(at);
    let minute = minutes.get(start);
    if (minute === undefined) {
      minute = { rows: new Map(), asns: new Set(), tops: new Map() };
      minutes.set(start, minute);
      if (minutes.size > maxPending) {
        const oldest = Math.min(...minutes.keys());
        const dropped = minutes.get(oldest)!;
        minutes.delete(oldest);
        countOverflow("minutes", at, dropped.rows.size);
      }
    }
    return minute;
  };

  /** Adds to one row of a minute, folding into `(other)` past the row bound. */
  const add = (
    minute: Minute,
    at: number,
    metric: string,
    dims: Record<string, string>,
    value: number,
  ): void => {
    for (const name of Object.keys(dims)) dims[name] = fit(dims[name]);
    let key = rowKey(metric, dims);
    let row = minute.rows.get(key);
    if (row === undefined && minute.rows.size >= maxRows) {
      const folded = Object.fromEntries(
        Object.keys(dims).map((name) => [name, OTHER]),
      );
      key = rowKey(metric, folded);
      row = minute.rows.get(key);
      countOverflow(`rows:${metric}`, at, value);
      if (row === undefined) {
        row = { metric, dims: folded, value: 0 };
        minute.rows.set(key, row);
      }
    } else if (row === undefined) {
      row = { metric, dims, value: 0 };
      minute.rows.set(key, row);
    }
    row.value += value;
  };

  /** Offers a subject to a minute's top-K of `metric`. */
  const offer = (
    minute: Minute,
    metric: string,
    kind: string,
    subject: string,
  ): void => {
    const key = `${metric}\u0000${kind}`;
    let summary = minute.tops.get(key);
    if (summary === undefined) {
      summary = new SpaceSaving(topK);
      minute.tops.set(key, summary);
    }
    summary.offer(fit(subject));
  };

  /** Counts a refusal of a subject, exactly, for its day. */
  const refuse = (at: number, kind: string, subject: string): void => {
    const day = dayOf(at);
    let counts = refused.get(day);
    if (counts === undefined) {
      counts = new Map();
      refused.set(day, counts);
    }
    let key = `${kind}\u0000${fit(subject)}`;
    if (!counts.has(key) && refusedSize >= maxRefused) {
      key = `${kind}\u0000${OTHER}`;
      countOverflow("refused", at);
    }
    if (!counts.has(key)) refusedSize += 1;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };

  const record = (input: AnalyticsRecord): void => {
    const at = input.at ?? now();
    const minute = minuteFor(at);
    const { action } = input;
    add(minute, at, ANALYTICS_METRICS.requests, { action }, 1);
    if (input.route !== undefined) {
      add(
        minute,
        at,
        ANALYTICS_METRICS.routes,
        { route: input.route, action },
        1,
      );
    }
    for (const hit of input.hits ?? []) {
      add(
        minute,
        at,
        ANALYTICS_METRICS.rules,
        {
          rule: hit.rule,
          action: hit.action,
          dryRun: String(hit.dryRun === true),
        },
        1,
      );
    }
    if (input.country !== undefined) {
      add(
        minute,
        at,
        ANALYTICS_METRICS.countries,
        { country: input.country, action },
        1,
      );
    }
    if (input.asn !== undefined) {
      let asn = String(input.asn);
      if (!minute.asns.has(asn)) {
        if (minute.asns.size >= maxAsns) {
          asn = OTHER;
          countOverflow("asns", at);
        } else minute.asns.add(asn);
      }
      add(minute, at, ANALYTICS_METRICS.asns, { asn, action }, 1);
    }
    const klass = statusClass(input.status);
    if (klass !== undefined)
      add(minute, at, ANALYTICS_METRICS.responses, { class: klass }, 1);
    if (
      input.latencyMs !== undefined &&
      Number.isFinite(input.latencyMs) &&
      input.latencyMs >= 0
    ) {
      add(
        minute,
        at,
        ANALYTICS_METRICS.latency,
        { le: latencyBucket(input.latencyMs) },
        1,
      );
    }
    const refusing = REFUSING_ACTIONS.includes(action);
    for (const kind of kinds) {
      // Already keyed by the engine: the address key and the HMACs.
      const subject = input.subject?.[kind];
      if (subject === undefined || subject === "") continue;
      offer(minute, ANALYTICS_METRICS.topRequests, kind, subject);
      if (refusing) {
        offer(minute, ANALYTICS_METRICS.topRefused, kind, subject);
        refuse(at, kind, subject);
      }
    }
  };

  const recorder: AnalyticsRecorder = {
    record,
    recordDecision: (decision, extras = {}) => {
      record({
        ...extras,
        action: decision.action,
        hits: decision.hits.map((hit) => ({
          rule: scrubRule(hit.rule, decision.subject),
          action: hit.wouldHaveBeen ?? hit.action,
          dryRun: hit.wouldHaveBeen !== undefined,
        })),
        subject: decision.subject,
      });
    },
    count: (metric, dims = {}, value = 1, at = now()) => {
      // Checked as the store will check it, so one bad call never fails a batch.
      resolveCounters([{ service, at, metric, dims, value }]);
      add(minuteFor(at), at, metric, { ...dims }, value);
    },
    flush: (flushOptions = {}) => {
      const open = minuteOf(now());
      const out: CounterRow[] = [];
      for (const [start, minute] of [...minutes].sort((a, b) => a[0] - b[0])) {
        if (start >= open && flushOptions.all !== true) continue;
        minutes.delete(start);
        for (const row of minute.rows.values()) {
          out.push({
            service,
            at: start,
            metric: row.metric,
            dims: row.dims,
            value: row.value,
          });
        }
        for (const [key, summary] of minute.tops) {
          const [metric, kind] = key.split("\u0000") as [string, string];
          for (const entry of summary.top()) {
            out.push({
              service,
              at: start,
              metric,
              dims: { kind, subject: entry.key },
              value: entry.count,
            });
          }
        }
      }
      for (const [day, counts] of refused) {
        for (const [key, value] of counts) {
          const [kind, subject] = key.split("\u0000") as [string, string];
          out.push({
            service,
            tier: "day",
            at: day,
            metric: ANALYTICS_METRICS.refused,
            dims: { kind, subject },
            value,
          });
        }
      }
      refused.clear();
      refusedSize = 0;
      for (const [what, { at, value }] of overflow) {
        out.push({
          service,
          at,
          metric: ANALYTICS_METRICS.overflow,
          dims: { what },
          value,
        });
      }
      overflow.clear();
      return out;
    },
    stats: () => ({
      pendingMinutes: minutes.size,
      pendingRows: [...minutes.values()].reduce(
        (sum, minute) => sum + minute.rows.size,
        0,
      ),
      pendingRefused: refusedSize,
    }),
  };
  return Object.freeze(recorder);
}
