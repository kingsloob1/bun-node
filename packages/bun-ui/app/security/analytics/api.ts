/**
 * The analytics page's reads (PR-U2), over CP5's and PR-AN's routes: a
 * series, a top-N, a distinct count, the highest scores and the ban
 * timeline, each for the scope on screen and the range's bounds now (a
 * preset is resolved at each read, so a refetch follows the clock).
 */
import type { Routes } from "../api/routes.gen";
import type { SecurityClient } from "../api/client";
import type { AnalyticsRange, Tier } from "./range";
import { rangeBounds } from "../../kit/range";
import { dataOf } from "../api/client";
import { TIER_MS, tierOf } from "./range";

/** A series' answer. */
export type SeriesDto = Routes["GET /analytics/series"]["responses"][200];
/** A top-N's answer. */
export type TopDto = Routes["GET /analytics/top"]["responses"][200];
/** The ban timeline. */
export type BanTimelineDto = Routes["GET /analytics/bans"]["responses"][200];
/** The highest scores. */
export type ScoresDto = Routes["GET /analytics/scores"]["responses"][200];
/** A distinct count. */
export type DistinctDto = Routes["GET /analytics/distinct"]["responses"][200];
/** A page of agents. */
export type AgentsDto = Routes["GET /agents"]["responses"][200];
/** The dimension filters a counter read takes. */
export type DimFilters = Partial<
  Pick<
    Routes["GET /analytics/series"]["query"],
    | "action"
    | "route"
    | "rule"
    | "country"
    | "asn"
    | "kind"
    | "subject"
    | "dryRun"
    | "class"
    | "le"
    | "what"
    | "reason"
    | "cap"
    | "outcome"
    | "pattern"
  >
>;

/** What every read is for. */
export interface ReadContext {
  /** The client. */
  readonly client: SecurityClient["client"];
  /** The scope. */
  readonly scope: string;
  /** The range. */
  readonly range: AnalyticsRange;
  /** Aborts the read. */
  readonly signal?: AbortSignal;
}

/** The range's bounds now, with the tier. */
export function window(range: AnalyticsRange, now = Date.now()) {
  return { ...rangeBounds(range, now), tier: tierOf(range, now) };
}

/** A part of a range read at one tier. */
export interface Segment {
  /** Its start, epoch ms. */
  readonly from: number;
  /** Its end, exclusive. */
  readonly to: number;
  /** The tier it is read at. */
  readonly tier: Tier;
}

/**
 * The parts a range is read in. A coarse tier holds a bucket only once it
 * has ended and the rollup ran (README §8.3), so the part of a range inside
 * the current hour (and day) is read at the finer tiers that hold it: a
 * 24-hour range is its closed hours at the hour tier and this hour at the
 * minute tier.
 */
export function segments(
  from: number,
  to: number,
  tier: Tier,
  now = Date.now(),
): Segment[] {
  if (tier === "minute") return [{ from, to, tier }];
  const hour = Math.floor(now / TIER_MS.hour) * TIER_MS.hour;
  const day = Math.floor(now / TIER_MS.day) * TIER_MS.day;
  const cuts: Segment[] = [];
  let start = from;
  const push = (end: number, at: Tier) => {
    const stop = Math.min(end, to);
    if (stop > start) cuts.push({ from: start, to: stop, tier: at });
    start = Math.max(start, stop);
  };
  if (tier === "day") push(day, "day");
  push(hour, "hour");
  push(to, "minute");
  return cuts;
}

/** `GET /analytics/series`, at the range's tier, each point's bucket that tier's (see {@link segments}). */
export async function readSeries(
  context: ReadContext,
  metric: string,
  dims: DimFilters = {},
  options: {
    readonly groupBy?: "service";
    readonly tier?: Tier;
    readonly from?: number;
    readonly to?: number;
  } = {},
): Promise<SeriesDto> {
  const bounds = window(context.range);
  const tier = options.tier ?? bounds.tier;
  const from = options.from ?? bounds.from;
  const to = options.to ?? bounds.to;
  // A tier asked for by name (a metric written at it) is read as it is.
  const parts =
    options.tier === undefined
      ? segments(from, to, tier)
      : [{ from, to, tier }];
  const answers = await Promise.all(
    parts.map(
      async (part) =>
        await dataOf(
          context.client.get("/analytics/series", {
            query: {
              scope: context.scope,
              metric,
              from: part.from,
              to: part.to,
              tier: part.tier,
              ...dims,
              ...(options.groupBy === undefined
                ? {}
                : { groupBy: options.groupBy }),
            },
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          }),
        ),
    ),
  );
  if (answers.length === 1) return answers[0]!;
  const width = TIER_MS[tier];
  const merged = new Map<string, SeriesDto["points"][number]>();
  for (const answer of answers) {
    for (const point of answer.points) {
      const at = Math.floor(point.at / width) * width;
      const key = `${at}\u0000${point.service ?? ""}\u0000${JSON.stringify(Object.entries(point.dims).sort())}`;
      const known = merged.get(key);
      merged.set(key, {
        ...point,
        at,
        value: (known?.value ?? 0) + point.value,
      });
    }
  }
  return {
    tier,
    points: [...merged.values()].sort((a, b) => a.at - b.at),
  };
}

/** `GET /analytics/top`, over the range's parts (see {@link segments}), summed and ranked again. */
export async function readTop(
  context: ReadContext,
  metric: string,
  dims: DimFilters = {},
  limit = 10,
): Promise<TopDto> {
  const bounds = window(context.range);
  const answers = await Promise.all(
    segments(bounds.from, bounds.to, bounds.tier).map(
      async (part) =>
        await dataOf(
          context.client.get("/analytics/top", {
            query: {
              scope: context.scope,
              metric,
              from: part.from,
              to: part.to,
              tier: part.tier,
              limit,
              ...dims,
            },
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          }),
        ),
    ),
  );
  if (answers.length === 1) return answers[0]!;
  const sums = new Map<string, TopDto["rows"][number]>();
  for (const answer of answers) {
    for (const row of answer.rows) {
      const key = JSON.stringify(Object.entries(row.dims).sort());
      const known = sums.get(key);
      sums.set(key, { dims: row.dims, value: (known?.value ?? 0) + row.value });
    }
  }
  return {
    rows: [...sums.values()].sort((a, b) => b.value - a.value).slice(0, limit),
  };
}

/** `GET /analytics/distinct`. */
export async function readDistinct(
  context: ReadContext,
  metric: string,
  dims: DimFilters,
  tier?: Tier,
): Promise<DistinctDto> {
  const bounds = window(context.range);
  return await dataOf(
    context.client.get("/analytics/distinct", {
      query: {
        scope: context.scope,
        metric,
        from: bounds.from,
        to: bounds.to,
        tier: tier ?? bounds.tier,
        ...dims,
      },
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    }),
  );
}

/** `GET /analytics/scores`. */
export async function readScores(
  context: ReadContext,
  limit = 10,
): Promise<ScoresDto> {
  const bounds = window(context.range);
  return await dataOf(
    context.client.get("/analytics/scores", {
      query: { scope: context.scope, from: bounds.from, to: bounds.to, limit },
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    }),
  );
}

/** `GET /analytics/bans`. */
export async function readBanTimeline(
  context: ReadContext,
): Promise<BanTimelineDto> {
  const bounds = window(context.range);
  return await dataOf(
    context.client.get("/analytics/bans", {
      query: { scope: context.scope, from: bounds.from, to: bounds.to },
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    }),
  );
}

/** `GET /agents`, the first 200. */
export async function readAgents(
  context: Pick<ReadContext, "client" | "signal">,
): Promise<AgentsDto> {
  return await dataOf(
    context.client.get("/agents", {
      query: { limit: 200 },
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    }),
  );
}

/** Sums a series' points by one of their dims (`action`), in order of first sight. */
export function sumBy(series: SeriesDto, dim: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const point of series.points) {
    const key = point.dims[dim] ?? "(none)";
    out.set(key, (out.get(key) ?? 0) + point.value);
  }
  return out;
}
