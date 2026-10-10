import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import type {
  BucketRange,
  MetricsSupport,
  WorkerInfo,
} from "../../drivers/index";
import type { BunQueue } from "../../queue/BunQueue";
import type { JobDefaultsUpdate } from "../../queue/jobDefaults";
import type { JobDefaultsInfo } from "../../queue/types";
import type { LocalGroupView } from "../../summon/status";
import type { SummonGroupStatus, SummonStatus } from "../../summon/types";
import type { AuthDecision } from "../auth";
import type { JobsApiAuthorizeContext, ResolvedJobsApiConfig } from "../config";
import type {
  AddedByStateDto,
  ApplyJobDefaultsResultDto,
  JobDefaultsDto,
  OverviewDto,
  PageInfoDto,
  QueueDemandDto,
  QueueThroughputDto,
  ThroughputBucketDto,
} from "../contract/types";
import type { QueueSummaryDto } from "../serialize";
import type { RangeQueryInput } from "./analytics";
import type { AnyRouteDef, RouteServices } from "./define";
import {
  countAdded,
  DEFAULT_DEMAND_CAP,
  emptyAddedCounts,
  supportsWorkers,
  THROUGHPUT_BUCKET_MS,
  THROUGHPUT_RETENTION_MS,
  throughputBucket,
} from "../../drivers/index";
import { jobDefaultIssue } from "../../queue/jobDefaults";
import { normalizeLimits } from "../../queue/limits";
import { resetGroup } from "../../summon/group";
import {
  listSummonGroupNames,
  readStoredGroupStatus,
} from "../../summon/status";
import { decide, denialError } from "../auth";
import {
  JOB_DEFAULT_KEYS,
  MAX_ADDED_BY_STATE_SPAN_MS,
} from "../contract/constants";
import { ApiError, mapCallSiteError } from "../errors";
import {
  DEMAND_METRICS,
  DEMAND_TRUNCATED_METRIC,
  PROMETHEUS_CONTENT_TYPE,
  PROMETHEUS_MEDIA_TYPE,
  renderDemandExposition,
} from "../prometheus";
import { s } from "../schema/builder";
import { JOB_STATES } from "../schemas/common";
import {
  addedByStateQuerySchema,
  AddedByStateSchema,
  applyJobDefaultsBodySchema,
  ApplyJobDefaultsResultSchema,
  cleanBodySchema,
  CleanResultSchema,
  CountResultSchema,
  DrainBodySchema,
  JobCountsSchema,
  JobDefaultsBodySchema,
  JobDefaultsSchema,
  minutesQuerySchema,
  OverviewSchema,
  PausedSchema,
  queueDemandListQuerySchema,
  QueueDemandListSchema,
  QueueDemandQuerySchema,
  QueueDemandSchema,
  QueueDetailSchema,
  QueueLimitsInputSchema,
  queueListQuerySchema,
  QueueListSchema,
  ResetJobDefaultsQuerySchema,
  StoredLimitsSchema,
  SummonCheckSchema,
  SummonGroupListSchema,
  SummonGroupResetBodySchema,
  SummonGroupStatusSchema,
  SummonListSchema,
  SummonNowBodySchema,
  SummonResetBodySchema,
  SummonStatusSchema,
  ThroughputSchema,
} from "../schemas/queues";
import {
  toSummonCheckDto,
  toSummonGroupStatusDto,
  toSummonListItemDto,
  toSummonStatusDto,
} from "../serialize";
import { parseSegment } from "../sources";
import { overviewAnalytics, requestedRange, resolveRange } from "./analytics";
import { defineRoute } from "./define";
import { DRIVER_FEATURES, driverImplements } from "./meta";
import {
  mapBounded,
  QueueParams,
  queueTarget,
  SummonGroupParams,
} from "./support";

/** The driver methods queue limits need. */
const LIMITS_METHODS = ["getQueueState", "setQueueState"] as const;

/** The most minutes of throughput any route reads: what a driver retains. */
const MAX_THROUGHPUT_MINUTES = THROUGHPUT_RETENTION_MS / THROUGHPUT_BUCKET_MS;

/**
 * What the shipped throughput reads can serve: minutes, kept for
 * `THROUGHPUT_RETENTION_MS`. An explicit `from`/`to` on `/overview` or
 * `/queues/:queue/throughput` resolves against this, so it is clamped and
 * refused exactly as an analytics range is — and always served at a minute,
 * whatever `resolution` hints, because these responses have always been.
 */
const MINUTE_THROUGHPUT: MetricsSupport = Object.freeze({
  resolutions: [60],
  retentionMs: { 60: THROUGHPUT_RETENTION_MS },
  recording: {
    resolution: "minute",
    secondRetentionMs: 0,
    workers: false,
    runners: false,
    durations: false,
  },
}) as MetricsSupport;

/**
 * The minutes an explicit `from`/`to` asks for — bucket starts, both
 * inclusive, after the request's exclusive `to` is resolved — or `undefined`
 * when the request named neither and the deprecated `minutes` applies.
 */
function minuteWindow(query: RangeQueryInput): BucketRange | undefined {
  if (query.from === undefined && query.to === undefined) {
    return undefined;
  }
  const { from, to } = resolveRange(query, MINUTE_THROUGHPUT, Date.now());
  return { from, to };
}

/**
 * A queue's throughput over an explicit window, in the shipped
 * `QueueThroughputDto` shape: one bucket per minute, contiguous.
 */
async function windowThroughput(
  services: RouteServices,
  queue: BunQueue<any, any, any>,
  window: BucketRange,
): Promise<QueueThroughputDto> {
  await queue.connect();
  const stored = new Map(
    (await services.config.driver.getThroughput!(queue.ref, window)).map(
      (bucket) => [bucket.at, bucket],
    ),
  );
  const buckets: ThroughputBucketDto[] = [];
  for (let at = window.from; at <= window.to; at += THROUGHPUT_BUCKET_MS) {
    const bucket = stored.get(at);
    buckets.push({
      at,
      completed: bucket?.completed ?? 0,
      failed: bucket?.failed ?? 0,
    });
  }
  return {
    interval: THROUGHPUT_BUCKET_MS,
    from: window.from,
    to: window.to,
    buckets,
    completed: buckets.reduce((sum, bucket) => sum + bucket.completed, 0),
    failed: buckets.reduce((sum, bucket) => sum + bucket.failed, 0),
  };
}

/** A queue's counts, total and paused flag. */
export async function summarizeQueue(
  queue: BunQueue<any, any, any>,
): Promise<QueueSummaryDto> {
  const [counts, paused] = await Promise.all([queue.count(), queue.isPaused()]);
  const total = JOB_STATES.reduce((sum, state) => sum + counts[state], 0);
  return { name: queue.name, counts, total, paused };
}

/**
 * Whether a queue name matches a `search`: a substring, ignoring case — the
 * rule job search uses (`LOWER(…) LIKE`, `toLowerCase().includes`). Queue
 * names are ASCII key segments, so lower-casing both sides is exact.
 */
export function queueNameMatches(name: string, search?: string): boolean {
  return !search || name.toLowerCase().includes(search.toLowerCase());
}

/**
 * The route `GET /queues/:queue` reports to `authorize` — the context a
 * `listQueues: "authorized"` check carries, so a host deciding by route
 * answers it as it answers the queue's own read.
 */
const QUEUE_READ_ROUTE: NonNullable<JobsApiAuthorizeContext["route"]> =
  Object.freeze({ method: "GET", path: "/queues/:queue" });

/**
 * The route `GET /queues/:queue/summon` reports to `authorize`: what
 * `GET /summon` asks about each controller's queue, so the list is never
 * looser than the per-queue status it summarises.
 */
const SUMMON_READ_ROUTE: NonNullable<JobsApiAuthorizeContext["route"]> =
  Object.freeze({ method: "GET", path: "/queues/:queue/summon" });

/**
 * The queues of `names` whose summon status the caller may read: those
 * `authorize` allows `queues.read` on, asked exactly as
 * `GET /queues/:queue/summon` asks it (`queue`, `transport: "http"`, its
 * route) — whatever `listQueues` says, since a summon status carries more
 * than a queue's name (its last outcome's detail, its budget). At most
 * `FAN_OUT` at a time; order kept. A throwing `authorize` rejects.
 */
async function readableSummonQueues(
  services: RouteServices,
  req: BunRequest,
  names: readonly string[],
): Promise<string[]> {
  const allowed = await mapBounded(
    names,
    async (queue) =>
      (
        await decide(services.config, req, {
          action: "queues.read",
          transport: "http",
          queue,
          route: SUMMON_READ_ROUTE,
        })
      ).allow,
  );
  return names.filter((_, index) => allowed[index]);
}

/**
 * `queues.read` decisions already asked during a request, by queue: a request
 * never asks `authorize` twice about one queue, however many of its reads
 * filter. Keyed weakly, so a finished request's decisions go with it.
 */
const readDecisions = new WeakMap<BunRequest, Map<string, Promise<boolean>>>();

/**
 * The names a caller is shown: all of them under `listQueues: "all"`; under
 * `"authorized"`, those `authorize` allows `queues.read` on — asked with the
 * context `GET /queues/:queue` carries, at most `FAN_OUT` at a time, once per
 * queue per request. Order is kept. A throwing `authorize` rejects, and the
 * request fails as any route's does.
 */
export async function visibleQueueNames(
  services: RouteServices,
  req: BunRequest,
  names: readonly string[],
): Promise<string[]> {
  const { config } = services;
  if (config.listQueues !== "authorized") {
    return [...names];
  }
  let decisions = readDecisions.get(req);
  if (!decisions) {
    decisions = new Map();
    readDecisions.set(req, decisions);
  }
  const cache = decisions;
  const allowed = await mapBounded(names, async (queue) => {
    let decision = cache.get(queue);
    if (!decision) {
      decision = decide(config, req, {
        action: "queues.read",
        transport: "http",
        queue,
        route: QUEUE_READ_ROUTE,
      }).then((answer) => answer.allow);
      cache.set(queue, decision);
    }
    return await decision;
  });
  return names.filter((_, index) => allowed[index]);
}

/**
 * One page of summaries of the reachable queues whose name contains
 * `search` (ignoring case), sorted by name: `offset` names skipped, at most
 * `limit` (by default, and at most, `limits.maxQueues`) summarised, read
 * `FAN_OUT` queues at a time. Every path lists names the same way — through
 * `services.queues`, then this filter, then {@link visibleQueueNames} —
 * whatever the driver.
 */
async function summarizeQueues(
  services: RouteServices,
  req: BunRequest,
  options: { search?: string; offset?: number; limit?: number } = {},
): Promise<{
  items: QueueSummaryDto[];
  truncated: boolean;
  page: PageInfoDto;
}> {
  // Filtered before paging, so `offset`, `limit`, `total` and `hasMore` all
  // describe the list the caller is shown.
  const names = await visibleQueueNames(
    services,
    req,
    (await services.queues.names()).filter((name) =>
      queueNameMatches(name, options.search),
    ),
  );
  const offset = options.offset ?? 0;
  const limit = options.limit ?? services.config.limits.maxQueues;
  const chosen = names.slice(offset, offset + limit);

  // One read for every queue the backend knows, rather than a count and a
  // paused check per queue. It is a fast path, never a wider view: only names
  // `services.queues` already allowed are kept, so the `queues` allowlist
  // still decides what this answers, and a name the summaries do not cover
  // falls back to reading that queue.
  const summaries = new Map<string, QueueSummaryDto>();
  if (services.config.jobs) {
    for (const summary of await services.config.jobs.getQueueSummaries()) {
      summaries.set(summary.name, summary);
    }
  }

  const items = await mapBounded(chosen, async (name) => {
    return (
      summaries.get(name) ??
      (await summarizeQueue(await services.queues.get(name)))
    );
  });
  const hasMore = offset + chosen.length < names.length;
  return {
    items,
    truncated: hasMore,
    page: { offset, limit, total: names.length, hasMore },
  };
}

/** Live workers across the queues summarised, when the backend keeps records. */
async function overviewWorkers(
  services: RouteServices,
  names: readonly string[],
  listWorkers: () => Promise<WorkerInfo[]>,
): Promise<{ workers?: number }> {
  if (!services.config.jobs || !supportsWorkers(services.config.driver)) {
    return {};
  }
  const allowed = new Set(names);
  const workers = await listWorkers();
  return { workers: workers.filter((one) => allowed.has(one.queue)).length };
}

/**
 * What finished across the queues summarised, when the driver counts it.
 *
 * The driver contract counts throughput per queue only (`getThroughput(q,
 * range)`), with no namespace-wide read, so this reads each queue — at most
 * `FAN_OUT` at a time — and sums them. `throughput` is unchanged: the sums
 * of each queue's own totals. `throughputSeries` sums the buckets by minute
 * over the window of the newest read (reads straddling a minute boundary would
 * otherwise disagree about which minute is current), and its totals are those
 * buckets' sums.
 */
async function overviewThroughput(
  services: RouteServices,
  names: readonly string[],
  minutes: number,
  window: BucketRange | undefined,
): Promise<{
  throughput?: OverviewDto["throughput"];
  throughputSeries?: QueueThroughputDto;
}> {
  if (!driverImplements(services.config.driver, ["getThroughput"])) {
    return {};
  }
  const reads = await mapBounded(names, async (name) => {
    const queue = await services.queues.get(name);
    return window
      ? await windowThroughput(services, queue, window)
      : await queue.getThroughput({ minutes });
  });
  // An explicit window is fixed; `minutes` counts back from the newest read.
  const to =
    window?.to ??
    reads.reduce(
      (latest, read) => Math.max(latest, read.to),
      throughputBucket(Date.now()),
    );
  if (window) {
    minutes = (window.to - window.from) / THROUGHPUT_BUCKET_MS + 1;
  }
  const from = to - (minutes - 1) * THROUGHPUT_BUCKET_MS;
  const byMinute = new Map<number, ThroughputBucketDto>();
  for (let at = from; at <= to; at += THROUGHPUT_BUCKET_MS) {
    byMinute.set(at, { at, completed: 0, failed: 0 });
  }
  for (const read of reads) {
    for (const bucket of read.buckets) {
      const sum = byMinute.get(bucket.at);
      if (sum) {
        sum.completed += bucket.completed;
        sum.failed += bucket.failed;
      }
    }
  }
  const buckets = [...byMinute.values()];
  return {
    throughput: {
      minutes,
      completed: reads.reduce((sum, read) => sum + read.completed, 0),
      failed: reads.reduce((sum, read) => sum + read.failed, 0),
    },
    throughputSeries: {
      interval: THROUGHPUT_BUCKET_MS,
      from,
      to,
      buckets,
      completed: buckets.reduce((sum, bucket) => sum + bucket.completed, 0),
      failed: buckets.reduce((sum, bucket) => sum + bucket.failed, 0),
    },
  };
}

/**
 * The range an added-by-state read counts over: the analytics range rules
 * (`to` defaults to now, `from` to an hour before it, `to` exclusive, at least
 * `MIN_ANALYTICS_SPAN_MS`) with its own cap, `MAX_ADDED_BY_STATE_SPAN_MS`, and
 * no buckets or retention clamp — the counts come from the jobs themselves.
 */
function addedRange(
  query: { from?: number | string; to?: number | string },
  now: number,
): { from: number; to: number } {
  return requestedRange(query, now, MAX_ADDED_BY_STATE_SPAN_MS);
}

/** An added-by-state body from one queue's counts, or several summed. */
function addedBody(
  range: { from: number; to: number },
  at: number,
  perQueue: readonly Record<string, number>[],
  queues: number,
): AddedByStateDto {
  const counts = emptyAddedCounts();
  for (const one of perQueue) {
    for (const state of JOB_STATES) {
      counts[state] += one[state] ?? 0;
    }
  }
  const total = JOB_STATES.reduce((sum, state) => sum + counts[state], 0);
  return { from: range.from, to: range.to, at, counts, total, queues };
}

/**
 * What both added-by-state routes say about their numbers, once, so the two
 * descriptions cannot drift apart.
 */
const ADDED_BY_STATE_NOTE =
  "Counts the jobs whose `createdAt` is in `[from, to)` — **`from` inclusive, `to` exclusive** — by the state each is in **now**. `to` defaults to now and `from` to an hour before `to`; `to` not after `from`, a span over `MAX_ADDED_BY_STATE_SPAN_MS` (a day) or under `MIN_ANALYTICS_SPAN_MS` (a second) is 400 `INVALID_ARGUMENT`. No buckets and no retention clamp: the counts come from the jobs themselves, not from the analytics roll-up.\n\nOnly jobs **still stored** are counted: one removed since — by `removeOnComplete`/`removeOnFail` retention, or a remove, clean or drain — is not, so for a queue that removes finished jobs `completed` and `dead` undercount and `total` is less than what was added. This is **not** the analytics series: that counts completions and failed attempts by **finish** time, over every job whenever it was added. Here `failed` is the *state* (failed, a retry pending) and `dead` the jobs that gave up. `createdAt` is the producer's clock, and a repeatable's next run is created ahead of its time, so scheduled future runs count as added, in `delayed`.\n\nServed where `features.addedByState` is true (memory, SQL, MongoDB); pruned elsewhere, never a 501. It reads job rows, so poll it every 15–30 s rather than at the overview's pace.";

/** Applies of job defaults in flight, per API and queue: one at a time per queue in a process. */
const APPLY_DEFAULTS_RUNNING = new WeakMap<RouteServices, Set<string>>();

/**
 * What every job-defaults route says about how a save travels and what apply
 * can and cannot do, once, so the four descriptions cannot drift apart.
 */
const JOB_DEFAULTS_NOTE =
  "Precedence, highest first: an option passed on the job's own `add()`; the stored override; the code's defaults (a `define()` definition's for its name, then the queue's `defaultJobOptions`); the built-ins. **The override never replaces an option passed on `add()`.** A save reaches every producer in every process within `propagationMs` (its `jobDefaultsRefreshInterval`, 1 000 ms by default) plus one read, and this API's own queue at once; jobs already pending keep what they were given until the apply action rewrites them. Apply is **irreversible**: a rewritten job's earlier values are not kept, so a later reset changes new jobs only — and after a reset the override sets nothing, so apply has nothing to write.";

/** A queue's job defaults as `JobDefaultsDto`: the queue's description, and its pending counts. */
async function jobDefaultsBody(
  queue: BunQueue<any, any, any>,
  info: JobDefaultsInfo,
): Promise<JobDefaultsDto> {
  const counts = await queue.count();
  const pending = {
    waiting: counts.waiting,
    delayed: counts.delayed,
    failed: counts.failed,
    "waiting-children": counts["waiting-children"],
  };
  return {
    queue: queue.name,
    effective: info.effective,
    code: info.code,
    codeSource: "api",
    overridden: info.overridden,
    override: info.override,
    seq: info.seq,
    ...(info.updatedAt === undefined ? {} : { updatedAt: info.updatedAt }),
    propagationMs: info.propagationMs,
    pending: {
      ...pending,
      total:
        pending.waiting +
        pending.delayed +
        pending.failed +
        pending["waiting-children"],
    },
  };
}

/** Refuses a save somebody else's write beat: 409 `CONTROL_CONTENDED`, nothing changed. */
function refuseContended(queue: string, info: { seq: number }): never {
  throw new ApiError(
    "CONTROL_CONTENDED",
    409,
    `The job defaults of queue "${queue}" changed while this write was being made; read them again and retry`,
    { context: { queue, seq: info.seq } },
  );
}

/**
 * The rules a body shape cannot hold, as 400 `VALIDATION` with the issue on
 * the field: a retention object with neither `count` nor `ttl`, and a backoff
 * whose `max` is below its `delay`. Then every value is checked by the very
 * rule the queue stores it under, so a value the schema let through and the
 * queue would refuse is still answered here, with its path.
 */
function checkJobDefaultsBody(update: JobDefaultsUpdate): void {
  const refuse = (path: string, message: string): never => {
    throw new ApiError("VALIDATION", 400, message, {
      issues: [{ target: "body", path, message }],
    });
  };
  for (const key of JOB_DEFAULT_KEYS) {
    const value = update[key];
    if (value === undefined || value === null) {
      continue;
    }
    if (
      (key === "removeOnComplete" || key === "removeOnFail") &&
      typeof value === "object" &&
      (value as { count?: number }).count === undefined &&
      (value as { ttl?: number }).ttl === undefined
    ) {
      refuse(key, `${key} needs a count, a ttl, or both`);
    }
    if (key === "backoff" && typeof value === "object") {
      const backoff = value as { delay: number; max?: number };
      if (backoff.max !== undefined && backoff.max < backoff.delay) {
        refuse("backoff.max", "backoff.max must be at least backoff.delay");
      }
    }
    const issue = jobDefaultIssue(key, value);
    if (issue !== null) {
      refuse(key, issue);
    }
  }
}

/**
 * Whether a demand request asked for the Prometheus exposition: `format` when
 * sent, else `Accept` — the exposition only when `text/plain` (with the
 * format's version, or none) is preferred over JSON, which a Prometheus
 * server's scrape header is. No `Accept`, the any-type wildcard, a browser's
 * header, or a media type neither serves all answer JSON, never 406.
 */
function wantsExposition(
  req: BunRequest,
  format: "json" | "prometheus" | undefined,
): boolean {
  if (format !== undefined) {
    return format === "prometheus";
  }
  return (
    req.accepts(["application/json", PROMETHEUS_MEDIA_TYPE]) ===
    PROMETHEUS_MEDIA_TYPE
  );
}

/**
 * A queue's demand as the wire carries it: `getDemand()` with the name, at the
 * default cap. The routes take no cap from the caller (plan §6.4 D3).
 */
async function demandOf(
  queue: BunQueue<any, any, any>,
): Promise<QueueDemandDto> {
  const demand = await queue.getDemand();
  return { queue: queue.name, ...demand };
}

/**
 * Answers a demand route with the text exposition, writing the response
 * itself. Varies by `Accept`, which chose it when `format` did not.
 */
function sendExposition(
  res: BunResponse,
  ns: string,
  demands: readonly QueueDemandDto[],
  truncated = false,
): Record<string, never> {
  res.setHeader("Content-Type", PROMETHEUS_CONTENT_TYPE);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Vary", "Accept");
  res.status(200);
  res.send(renderDemandExposition(ns, demands, { truncated }));
  return {};
}

/**
 * A sample of the exposition, for the docs: the renderer's own output for one
 * queue, so the example cannot drift from what is served.
 */
const DEMAND_EXPOSITION_EXAMPLE = renderDemandExposition("shop", [
  {
    queue: "emails",
    at: 0,
    paused: false,
    waiting: 12,
    dueNow: 3,
    stalled: 0,
    active: 1,
    workers: 0,
    nextDueAt: null,
    demand: 15,
    outstanding: 16,
    capped: false,
    exact: true,
  },
]);

/** The families of every demand scrape, named once for the docs. */
const DEMAND_FAMILIES = [...DEMAND_METRICS, DEMAND_TRUNCATED_METRIC]
  .map((metric) => `\`${metric.name}\``)
  .join(", ");

/** The other representation both demand routes serve. */
const DEMAND_ALTERNATES = {
  [PROMETHEUS_MEDIA_TYPE]: {
    description: `The Prometheus text exposition: ${DEMAND_METRICS.length + 1} gauge families (${DEMAND_FAMILIES}). Each per-queue sample is labelled \`ns\` and \`queue\`; \`${DEMAND_TRUNCATED_METRIC.name}\` is one sample labelled \`ns\`, 1 when \`GET /demand\` left visible queues out (always 0 on the per-queue route), since an absent series reads as 0 to many scalers. \`bunjobs_queue_demand_exact\` is 0 where the figures come from the approximate fallback. Served as \`text/plain; version=0.0.4; charset=utf-8\` for \`?format=prometheus\`, or an \`Accept\` preferring \`text/plain\`.`,
    example: DEMAND_EXPOSITION_EXAMPLE,
  },
} as const;

/** What both demand routes say about their figures, once. */
const DEMAND_NOTE = `A few bounded reads per queue on every built-in driver, never a scan of retained history; each figure is counted up to ${DEFAULT_DEMAND_CAP.toLocaleString("en-US")} (\`DEFAULT_DEMAND_CAP\`, fixed: the routes take no \`cap\`), and \`capped\` says when one went past. Unlike \`/counts\`, due delayed jobs, due retries and stalled jobs are counted, and a paused queue answers \`demand\` and \`outstanding\` as \`0\` over its unchanged backlog, so one number is the answer. Point a launch-style scaler (a KEDA \`ScaledJob\`, an ACA event job) at \`demand\`, a scale-style one (a KEDA \`ScaledObject\`, CREMA) at \`outstanding\`. \`exact\` is \`false\` only on a custom driver without \`countDemand\`, whose fallback is right as a trigger and approximate as a count; it is the only signal of approximate figures (\`features.demand\` says only that these routes are served).\n\n\`?format=prometheus\` (or an \`Accept\` preferring \`text/plain\`) answers the Prometheus text exposition instead of JSON; errors are \`application/problem+json\` either way. Listing the live workers removes lapsed worker records where the backend prunes them, as \`GET /workers\` does; no job is touched.`;

/** Errors every route naming a queue can answer with. */
const QUEUE_ERRORS = ["INVALID_NAME", "QUEUE_NOT_FOUND"] as const;

/**
 * Errors every summon route can answer with. `DRIVER_ERROR` (503) is the
 * backend refusing a read — the membership check, or the controller's
 * marker read — as after `jobs.close()` closed the driver.
 */
const SUMMON_ERRORS = [
  ...QUEUE_ERRORS,
  "SUMMON_NOT_CONFIGURED",
  "DRIVER_ERROR",
] as const;

/** What every summon route says about where its controller comes from, once. */
const SUMMON_NOTE =
  "Served for a queue whose summon controller runs in the API's process: one the `jobs` context the API was given has, from `BunJobsOptions.summon` or `jobs.summonController()`. Elsewhere 409 `SUMMON_NOT_CONFIGURED`; the API never builds one. The summon state itself (attempts in flight, failures, backoff, circuit, budget) lives in the backend, shared by every controller on the queue in any process.";

/**
 * The view of summon group `name` of a controller in it running in the API's
 * process (the first, by build order), or `{}` when none does.
 */
function localGroupView(
  services: RouteServices,
  name: string,
): { local?: LocalGroupView } {
  const [first] = services.queues.summonGroupControllers(name);
  return first === undefined ? {} : { local: first.view };
}

/**
 * 409 `SUMMON_NOT_CONFIGURED` for a summon group a caller may see nothing of:
 * one with neither state nor a local controller — or, answered the same so
 * that its existence does not leak, one none of whose member queues the
 * caller may read.
 */
function groupNotConfigured(name: string): ApiError {
  return new ApiError(
    "SUMMON_NOT_CONFIGURED",
    409,
    `Summon group "${name}" has no shared state, and no controller in it runs in this process`,
    { context: { group: name } },
  );
}

/** 409 `SUMMON_NOT_CONFIGURED` for a group reset where no controller in the group runs. */
function groupResetNotConfigured(name: string): ApiError {
  return new ApiError(
    "SUMMON_NOT_CONFIGURED",
    409,
    `Summon group "${name}" can be reset only through an API whose process runs a controller in it, and none runs in this process`,
    { context: { group: name } },
  );
}

/** The route `GET /summon/groups/:group` reports to `authorize`. */
const GROUP_READ_ROUTE: NonNullable<JobsApiAuthorizeContext["route"]> =
  Object.freeze({ method: "GET", path: "/summon/groups/:group" });

/** The route `GET /summon/groups` reports to `authorize`. */
const GROUP_LIST_ROUTE: NonNullable<JobsApiAuthorizeContext["route"]> =
  Object.freeze({ method: "GET", path: "/summon/groups" });

/** The route `POST /summon/groups/:group/reset` reports to `authorize`. */
const GROUP_RESET_ROUTE: NonNullable<JobsApiAuthorizeContext["route"]> =
  Object.freeze({ method: "POST", path: "/summon/groups/:group/reset" });

/**
 * Asks `authorize` about `action` with no target, and throws its denial
 * (401/403) when it refuses: what a route that authorizes itself asks when
 * it has no queue to ask about.
 */
async function requireUntargeted(
  services: RouteServices,
  req: BunRequest,
  action: "queues.read" | "queues.summon",
  route: NonNullable<JobsApiAuthorizeContext["route"]>,
): Promise<void> {
  const decision = await decide(services.config, req, {
    action,
    transport: "http",
    route,
  });
  if (!decision.allow) {
    throw denialError(decision);
  }
}

/**
 * The `:group` a request names, checked as a segment. One that is not a
 * valid name (`__bunjobs` among them) is 400 `INVALID_NAME` only to a caller
 * `authorize` allows `action` without a target: the route authorizes itself,
 * so nothing about the request reaches a caller it would refuse.
 */
async function groupName(
  services: RouteServices,
  req: BunRequest,
  value: unknown,
  action: "queues.read" | "queues.summon",
  route: NonNullable<JobsApiAuthorizeContext["route"]>,
): Promise<string> {
  try {
    return parseSegment(value, "group");
  } catch (error) {
    await requireUntargeted(services, req, action, route);
    throw error;
  }
}

/**
 * A per-request `queues.read` asker for summon state: whether the caller may
 * read `queue`'s summon status, asked as `GET /queues/:queue/summon` asks it
 * ({@link SUMMON_READ_ROUTE}), once per queue per request.
 */
function summonReadAsker(
  services: RouteServices,
  req: BunRequest,
): (queue: string) => Promise<boolean> {
  const asked = new Map<string, Promise<boolean>>();
  return async (queue) => {
    let answer = asked.get(queue);
    if (answer === undefined) {
      answer = decide(services.config, req, {
        action: "queues.read",
        transport: "http",
        queue,
        route: SUMMON_READ_ROUTE,
      }).then((decision) => decision.allow);
      asked.set(queue, answer);
    }
    return await answer;
  };
}

/**
 * The queues a summon group's status names — its queue shares and the queue
 * of every circuit's `openedBy` — plus, with `local`, the queues of the
 * controllers in the group running in the API's process. In code-point order.
 */
function groupMembers(
  services: RouteServices,
  name: string,
  group: SummonGroupStatus | undefined,
  options: { local: boolean },
): string[] {
  const members = new Set<string>(Object.keys(group?.queues ?? {}));
  for (const circuit of [
    group?.circuit,
    ...Object.values(group?.circuits ?? {}),
  ]) {
    if (circuit?.openedBy !== undefined) {
      members.add(circuit.openedBy.queue);
    }
  }
  if (options.local) {
    for (const { controller } of services.queues.summonGroupControllers(name)) {
      members.add(controller.queue);
    }
  }
  return [...members].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * A summon group's status with nothing about a queue outside `readable`: its
 * share left out, and a circuit it opened without `openedBy`. The group-wide
 * counts, limits and every circuit's state stay: they govern every member.
 */
function redactGroup(
  group: SummonGroupStatus,
  readable: ReadonlySet<string>,
): SummonGroupStatus {
  const circuit = (
    one: NonNullable<SummonGroupStatus["circuit"]>,
  ): NonNullable<SummonGroupStatus["circuit"]> => {
    if (one.openedBy === undefined || readable.has(one.openedBy.queue)) {
      return one;
    }
    const { openedBy: _hidden, ...rest } = one;
    return rest;
  };
  return {
    ...group,
    queues: Object.fromEntries(
      Object.entries(group.queues).filter(([queue]) => readable.has(queue)),
    ),
    ...(group.circuit === undefined ? {} : { circuit: circuit(group.circuit) }),
    ...(group.circuits === undefined
      ? {}
      : {
          circuits: Object.fromEntries(
            Object.entries(group.circuits).map(([kind, one]) => [
              kind,
              circuit(one),
            ]),
          ),
        }),
  };
}

/**
 * `queues.read` without a target, asked at most once per request through
 * the function this returns: what a group naming no queue is shown under,
 * and what an unknown or hidden group's answer depends on.
 */
function untargetedReadAsker(
  services: RouteServices,
  req: BunRequest,
  route: NonNullable<JobsApiAuthorizeContext["route"]>,
): () => Promise<AuthDecision> {
  let asked: Promise<AuthDecision> | undefined;
  return async () => {
    asked ??= decide(services.config, req, {
      action: "queues.read",
      transport: "http",
      route,
    });
    return await asked;
  };
}

/**
 * What a caller may see of each summon group (the rule of `GET /summon`:
 * nothing about a queue reaches a caller refused `queues.read` on it): each
 * group redacted to the members it may read ({@link redactGroup}), or
 * `undefined` when it may read none of them. `authorize` is asked about the
 * members of every group together, once per queue, in code-point order
 * (`FAN_OUT` at a time), as `GET /queues/:queue/summon` asks it. A group
 * with no member at all (its shares cleared, no circuit opened, no
 * controller here) names no queue: it is shown when `untargeted` allows it,
 * asked after the members, and only then.
 */
async function visibleGroups(
  services: RouteServices,
  req: BunRequest,
  groups: readonly SummonGroupStatus[],
  untargeted: () => Promise<AuthDecision>,
): Promise<(SummonGroupStatus | undefined)[]> {
  const members = groups.map((group) =>
    groupMembers(services, group.name, group, { local: true }),
  );
  const all = [...new Set(members.flat())].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const allowed = await mapBounded(all, summonReadAsker(services, req));
  const readable = new Set(all.filter((_, index) => allowed[index]));
  const shown: (SummonGroupStatus | undefined)[] = [];
  for (const [index, group] of groups.entries()) {
    if (members[index]!.length === 0) {
      shown.push((await untargeted()).allow ? group : undefined);
      continue;
    }
    shown.push(
      members[index]!.some((queue) => readable.has(queue))
        ? redactGroup(group, readable)
        : undefined,
    );
  }
  return shown;
}

/**
 * A queue's summon status with its embedded group redacted to the members
 * the caller may read. `own` — the queue the route authorized — is the
 * caller's already: its status is the response.
 */
async function withVisibleGroup(
  services: RouteServices,
  req: BunRequest,
  status: SummonStatus,
  own: string,
): Promise<SummonStatus> {
  if (status.group === undefined) {
    return status;
  }
  const ask = summonReadAsker(services, req);
  const others = groupMembers(services, status.group.name, status.group, {
    local: false,
  }).filter((queue) => queue !== own);
  const allowed = await mapBounded(others, ask);
  const readable = new Set([
    own,
    ...others.filter((_, index) => allowed[index]),
  ]);
  return { ...status, group: redactGroup(status.group, readable) };
}

/** The queue routes: overview, list, detail, counts and queue-wide operations. */
export function queueRoutes(config: ResolvedJobsApiConfig): AnyRouteDef[] {
  const { limits } = config;
  return [
    defineRoute({
      method: "GET",
      path: "/overview",
      operationId: "getOverview",
      action: "metrics.read",
      mode: "jobs",
      summary: "Job counts across every reachable queue",
      description:
        "Sums the counts of up to `limits.maxQueues` queues; `truncated` says when there were more. With `listQueues: \"authorized\"`, only the queues `authorize` allows `queues.read` on are summed (one call per reachable queue). `workers` and `throughput` are present only where the backend keeps them. `throughputSeries` is the namespace-wide per-minute series, in the shape of `GET /queues/{queue}/throughput`: each queue's buckets summed (read a queue at a time, 16 at once).\n\n`analytics` is the namespace's jobs series over `from`/`to` at the resolution they resolve to (the last hour by default), from the roll-up — **one** read whatever the queue count, unless the API is restricted to some queues, where the queues summarised are summed instead. It is absent where the backend records no analytics (`meta.analytics` is `null`). `analytics.runners` and `analytics.workers` are the roll-ups `GET /analytics/runners` and `GET /analytics/workers` answer (without a batch), present only on a backend with grouped reads (all four of `getRunnerMetricsTotals`, `getRunnerMetricsMany`, `getWorkerMetricsTotals`, `getWorkerMetricsMany`), where each costs a fixed number of reads whatever the fleet — plus a lock read per runner row returned, at most `MAX_ANALYTICS_ROWS`. On a backend without them they are left out: there each row would cost a read per runner and per worker key on every overview poll, so the two routes serve them instead. **`to` is exclusive; `analytics.range.to` is the start of the last bucket, and `analytics.range.end` the exclusive end.** A range wholly older than retention is 400 `RANGE_NOT_RETAINED`.\n\n`minutes` is deprecated: `from`/`to`, when given, decide `throughput` and `throughputSeries` too, still a minute per bucket.",
      tags: ["Queues"],
      query: minutesQuerySchema(MAX_THROUGHPUT_MINUTES),
      responses: { 200: OverviewSchema },
      errors: ["INVALID_ARGUMENT", "RANGE_NOT_RETAINED"],
      handler: async ({ req, query, services }) => {
        const window = minuteWindow(query);
        const { items, truncated } = await summarizeQueues(services, req, {
          limit: services.config.limits.maxQueues,
        });
        const counts = Object.fromEntries(
          JOB_STATES.map((state) => [
            state,
            items.reduce((sum, item) => sum + item.counts[state], 0),
          ]),
        ) as QueueSummaryDto["counts"];
        const names = items.map((item) => item.name);
        // The worker list is read once and shared: the count and the
        // analytics roll-up both need it, and each read is a round trip per
        // queue. The three sections are independent, so they run together.
        let workerList: Promise<WorkerInfo[]> | undefined;
        const listWorkers = async (): Promise<WorkerInfo[]> =>
          await (workerList ??= services.config.jobs!.listWorkers());
        const [workers, throughput, analytics] = await Promise.all([
          overviewWorkers(services, names, listWorkers),
          overviewThroughput(services, names, query.minutes, window),
          overviewAnalytics(services, req, query, names, listWorkers),
        ]);
        return {
          body: {
            queues: items.length,
            pausedQueues: items.filter((item) => item.paused).length,
            counts,
            total: items.reduce((sum, item) => sum + item.total, 0),
            truncated,
            ...workers,
            ...throughput,
            ...analytics,
          },
        };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/overview/added",
      operationId: "getAddedByState",
      action: "metrics.read",
      mode: "jobs",
      requires: DRIVER_FEATURES.addedByState,
      summary: "Of the jobs added in a range, how many are in each state now",
      description: `${ADDED_BY_STATE_NOTE}\n\nSummed over every queue the caller may see — the \`queues\` allowlist, and with \`listQueues: "authorized"\` only the queues \`authorize\` allows \`queues.read\` on (one call per reachable queue, 16 at a time, as \`GET /overview\`). A queue the caller may not see is never counted. One grouped read answers every queue, so the cost does not grow with the queue count and nothing is truncated; \`queues\` says how many were summed.`,
      tags: ["Queues"],
      query: addedByStateQuerySchema(),
      responses: { 200: AddedByStateSchema },
      errors: ["INVALID_ARGUMENT"],
      handler: async ({ req, query, services }) => {
        const { config } = services;
        const range = addedRange(query, Date.now());
        // Listing names connects the driver, and decides what may be summed.
        const names = await visibleQueueNames(
          services,
          req,
          await services.queues.names(),
        );
        const at = Date.now();
        const grouped = await countAdded(
          config.driver,
          config.namespace,
          range,
        );
        const visible = names.map((name) => grouped[name] ?? {});
        return { body: addedBody(range, at, visible, names.length) };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/queues",
      operationId: "listQueues",
      action: "queues.list",
      mode: "jobs",
      summary: "Every reachable queue, at a glance",
      description:
        'A page of queues sorted by name: `limit` (at most, and by default, `limits.maxQueues`) after skipping `offset`. `search` keeps names containing it, ignoring case. `truncated` (the same as `page.hasMore`) says when more follow.\n\nWith `listQueues: "authorized"`, a queue is listed only when `authorize` allows `queues.read` on it, asked as `GET /queues/{queue}` would ask; paging and `page.total` count only those. That costs one `authorize` call per queue matching `search` (every one, since the total needs them all), 16 at a time.',
      tags: ["Queues"],
      query: queueListQuerySchema(limits.maxQueues),
      responses: { 200: QueueListSchema },
      handler: async ({ req, query, services }) => ({
        body: await summarizeQueues(services, req, query),
      }),
    }),
    defineRoute({
      method: "GET",
      path: "/demand",
      operationId: "listQueueDemand",
      action: "queues.list",
      mode: "jobs",
      summary: "Demand of several queues, or the namespace as one scrape",
      description: `Each queue's \`GET /queues/{queue}/demand\` answer, read 16 at a time: the queues \`queues\` names, in that order, or every visible queue by name, at most \`limits.maxQueues\` (\`truncated\` says when there were more). A name the caller cannot see — unknown, outside the \`queues\` allowlist, or, with \`listQueues: "authorized"\`, refused \`queues.read\` (asked as \`GET /queues/{queue}\` would ask, one call per queue) — is left out, never an error; a scaler that must fail on a missing queue reads \`GET /queues/{queue}/demand\`, which is 404.\n\n${DEMAND_NOTE}`,
      tags: ["Queues"],
      query: queueDemandListQuerySchema(limits.maxQueues),
      responses: { 200: QueueDemandListSchema },
      alternateContent: DEMAND_ALTERNATES,
      handler: async ({ req, res, query, services }) => {
        let names: string[];
        let truncated = false;
        if (query.queues !== undefined) {
          // Asked for by name: kept in the order asked, once each, and only
          // where reachable. A miss is checked against the backend as
          // `GET /queues/{queue}` checks it, at most once per cache window.
          const asked = [...new Set(query.queues)];
          // The bound is on distinct names, so it is checked here rather
          // than by the schema, which would count a repeat.
          if (asked.length > limits.maxQueues) {
            const message = `At most ${limits.maxQueues} distinct queues may be named (\`limits.maxQueues\`), got ${asked.length}`;
            throw new ApiError("VALIDATION", 400, message, {
              issues: [{ target: "query", path: "queues", message }],
            });
          }
          const reachable = await mapBounded(
            asked,
            async (name) => await services.queues.has(name),
          );
          names = await visibleQueueNames(
            services,
            req,
            asked.filter((_, index) => reachable[index]),
          );
        } else {
          names = await visibleQueueNames(
            services,
            req,
            await services.queues.names(),
          );
          truncated = names.length > limits.maxQueues;
          names = names.slice(0, limits.maxQueues);
        }
        const queues = await mapBounded(
          names,
          async (name) => await demandOf(await services.queues.get(name)),
        );
        if (wantsExposition(req, query.format)) {
          return sendExposition(
            res,
            services.config.namespace,
            queues,
            truncated,
          );
        }
        return { body: { queues, truncated }, headers: { Vary: "Accept" } };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/queues/:queue",
      operationId: "getQueue",
      action: "queues.read",
      mode: "jobs",
      summary: "One queue: counts, paused flag and limits",
      tags: ["Queues"],
      params: QueueParams,
      responses: { 200: QueueDetailSchema },
      errors: QUEUE_ERRORS,
      target: ({ params }) => queueTarget(params.queue),
      handler: async ({ params, services }) => {
        const queue = await services.queues.get(params.queue);
        const summary = await summarizeQueue(queue);
        return {
          body: driverImplements(services.config.driver, LIMITS_METHODS)
            ? { ...summary, limits: await queue.getLimits() }
            : summary,
        };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/queues/:queue/counts",
      operationId: "getQueueCounts",
      action: "queues.read",
      mode: "jobs",
      summary: "Jobs per state in one queue",
      tags: ["Queues"],
      params: QueueParams,
      responses: { 200: JobCountsSchema },
      errors: QUEUE_ERRORS,
      target: ({ params }) => queueTarget(params.queue),
      handler: async ({ params, services }) => ({
        body: await (await services.queues.get(params.queue)).count(),
      }),
    }),
    defineRoute({
      method: "GET",
      path: "/queues/:queue/counts/added",
      operationId: "getQueueAddedByState",
      action: "queues.read",
      mode: "jobs",
      requires: DRIVER_FEATURES.addedByState,
      summary:
        "Of one queue's jobs added in a range, how many are in each state now",
      description: ADDED_BY_STATE_NOTE,
      tags: ["Queues"],
      params: QueueParams,
      query: addedByStateQuerySchema(),
      responses: { 200: AddedByStateSchema },
      errors: [...QUEUE_ERRORS, "INVALID_ARGUMENT"],
      target: ({ params }) => queueTarget(params.queue),
      handler: async ({ params, query, services }) => {
        const range = addedRange(query, Date.now());
        const queue = await services.queues.get(params.queue);
        const at = Date.now();
        const counts = await queue.countAdded(range);
        return { body: addedBody(range, at, [counts], 1) };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/queues/:queue/demand",
      operationId: "getQueueDemand",
      action: "queues.read",
      mode: "jobs",
      summary:
        "How much work one queue has for a worker: the depth a scaler polls",
      description: DEMAND_NOTE,
      tags: ["Queues"],
      params: QueueParams,
      query: QueueDemandQuerySchema,
      responses: { 200: QueueDemandSchema },
      alternateContent: DEMAND_ALTERNATES,
      errors: QUEUE_ERRORS,
      target: ({ params }) => queueTarget(params.queue),
      handler: async ({ req, res, params, query, services }) => {
        const queue = await services.queues.get(params.queue);
        const demand = await demandOf(queue);
        if (wantsExposition(req, query.format)) {
          return sendExposition(res, services.config.namespace, [demand]);
        }
        return { body: demand, headers: { Vary: "Accept" } };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/summon",
      operationId: "listSummonControllers",
      action: "queues.list",
      mode: "jobs",
      summary:
        "Every summoning queue the API can read, with its budget usage and circuit",
      description: `One item per summoning queue the API can reach, by queue name. A queue whose summon controller runs in the API's process — from \`BunJobsOptions.summon\` or \`jobs.summonController()\` on the \`jobs\` the API was given — is \`local: true\`, with its summoner's kind, readiness and whether it is inert. A queue whose controller runs in another process is read from its summon state in storage, as \`local: false\`, with the kind its last claim persisted and no readiness. Each carries the last outcome, when an open circuit closes, and the budget usage with its limits (absent, with \`off: true\`, while the budget is off; read from storage, the limits the last claim persisted) and when each UTC window resets, as \`GET /queues/{queue}/summon\` has them. An empty list, never 409, when none summons. State a newer bun-jobs wrote is listed \`inert\` with \`inertReason: "newer-marker"\` and no \`budget\`; state that cannot be read at all is left out; state written before claims persisted their limits shows its counts with \`limitsUnknown: true\`. Reads the summon state of every reachable queue without a local controller (one queue-state read each: about 20–35 ms per 1,000 queues on SQLite, 75 ms on Postgres); spends nothing. Remote items are advertised by \`/meta.features.summonRemoteStatus\`.\n\nGated by \`queues.list\`, like \`GET /queues\` and \`GET /demand\`. Each queue is then listed only when \`authorize\` allows \`queues.read\` on it, asked as \`GET /queues/{queue}/summon\` asks it (one call per summoning queue, whatever \`listQueues\` says), so the list never shows what that route would refuse.`,
      tags: ["Queues"],
      responses: { 200: SummonListSchema },
      handler: async ({ req, services }) => {
        const controllers = services.queues.summonControllers();
        const local = new Set(
          controllers.map((controller) => controller.queue),
        );
        // Every other reachable queue, read from storage: one summoning from
        // another process has summon state; any other has none.
        const others = (await services.queues.names()).filter(
          (name) => !local.has(name),
        );
        const stored = await mapBounded(
          others,
          async (name) => await services.queues.storedSummonStatus(name),
        );
        const read = new Map<
          string,
          () => Promise<{ status: SummonStatus; kind?: string }>
        >();
        for (const controller of controllers) {
          read.set(controller.queue, async () => ({
            status: await controller.status(),
          }));
        }
        others.forEach((name, index) => {
          const found = stored[index];
          // Unreadable state has nothing to show: left out, never zeros.
          if (found !== undefined && found.unreadable !== true) {
            read.set(name, async () => found);
          }
        });
        const names = [...read.keys()].sort((a, b) =>
          a < b ? -1 : a > b ? 1 : 0,
        );
        const shown = await readableSummonQueues(services, req, names);
        const statuses = await mapBounded(
          shown,
          async (name) => await read.get(name)!(),
        );
        return {
          body: {
            controllers: statuses.map(({ status, kind }) =>
              toSummonListItemDto(services.config.namespace, status, kind),
            ),
          },
        };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/queues/:queue/summon",
      operationId: "getQueueSummon",
      action: "queues.read",
      mode: "jobs",
      summary:
        "A queue's summon status: attempts in flight, failures, circuit, budget",
      description: `The queue's shared summon state and the local controller's policy: attempts on their way (with when each counts as \`lost\`), consecutive failures, the backoff and circuit, the budget used this hour and today, the last outcome, the summon group's shared state when the queue is in one (redacted to the members the caller may read, as \`GET /summon/groups/{group}\` redacts it), and the summoner — its provider, declared capabilities and secret-free facts. Reads only; spends nothing. A pending attempt's platform \`handles\` only with \`serialize.exposeSummonHandles\`.\n\nFor a queue whose controller runs in another process, the shared state alone, read from storage, as \`local: false\`: no \`summoner\`, and the budget's limits the ones its last claim persisted (\`off\` when its budget was off, absent when none was persisted). Summon state a newer bun-jobs wrote is \`inert\` with \`inertReason: "newer-marker"\` and no \`budget\`; state that cannot be read at all is \`inert\` with \`inertReason: "unreadable-marker"\`, nothing pending, no failures and no \`budget\` (\`GET /summon\` leaves it out). 409 \`SUMMON_NOT_CONFIGURED\` only for a queue with neither a controller here nor summon state. Advertised by \`/meta.features.summonRemoteStatus\`.`,
      tags: ["Queues"],
      params: QueueParams,
      responses: { 200: SummonStatusSchema },
      errors: SUMMON_ERRORS,
      target: ({ params }) => queueTarget(params.queue),
      handler: async ({ req, params, services }) => {
        const { status } = await services.queues.summonStatus(params.queue);
        return {
          body: toSummonStatusDto(
            await withVisibleGroup(services, req, status, status.queue),
            services.config.serialize,
          ),
        };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/summon/groups",
      operationId: "listSummonGroups",
      action: "queues.list",
      mode: "jobs",
      requires: DRIVER_FEATURES.summonRemoteStatus,
      summary: "Every summon group: its shared budget usage and circuits",
      description: `One item per summon group (\`SummonPolicy.group\`) with shared state in the namespace, by name, read from storage whether or not a controller in it runs in the API's process: the attempts counted against the group this UTC hour and day across its queues, the limits (a local controller's in the group, else the ones its last charge persisted; absent, with \`off: true\`, while the group's budget is off), when each window resets, each queue's share of today's attempts, and every provider kind's shared circuit (\`circuits\`, plus \`circuit\` for a local controller's kind). Lists the namespace's group entries, then reads each; spends nothing. Gated by \`queues.list\`, like the other lists. Each group is redacted to the members the caller may read: \`authorize\` is asked \`queues.read\` about each member queue (its queues with a share, every \`openedBy\` queue, and the queues of its controllers in the API's process) as \`GET /queues/{queue}/summon\` asks it, and a refused member's share and the \`openedBy\` of a circuit it opened are left out; the counts, limits and circuits' state stay, as they govern every member. A group with no member the caller may read is left out (one with no member at all is shown when \`queues.read\` asked without a queue allows it). Advertised by \`/meta.features.summonRemoteStatus\`.`,
      tags: ["Queues"],
      responses: { 200: SummonGroupListSchema },
      handler: async ({ req, services }) => {
        const { driver, namespace } = services.config;
        const names = await listSummonGroupNames(driver, namespace);
        const now = Date.now();
        const groups = await mapBounded(
          names,
          async (name) =>
            await readStoredGroupStatus(
              driver,
              namespace,
              name,
              now,
              localGroupView(services, name),
            ),
        );
        const visible = await visibleGroups(
          services,
          req,
          groups.filter((group) => group !== undefined),
          untargetedReadAsker(services, req, GROUP_LIST_ROUTE),
        );
        return {
          body: {
            groups: visible
              .filter((group) => group !== undefined)
              .map((group) => toSummonGroupStatusDto(group)),
          },
        };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/summon/groups/:group",
      operationId: "getSummonGroup",
      action: "queues.read",
      mode: "jobs",
      requires: DRIVER_FEATURES.summonRemoteStatus,
      summary: "A summon group's shared budget usage and circuits",
      description: `One summon group's shared state, as \`GET /summon/groups\` has each, read from storage: no controller in the group need run in the API's process. With one, its limits and its kind's circuit; a group with a local controller and no state yet answers its zero counts. 409 \`SUMMON_NOT_CONFIGURED\` for a group with neither state nor a local controller. Spends nothing. Advertised by \`/meta.features.summonRemoteStatus\`.\n\nAuthorized per member, never by an untargeted \`queues.read\`, so a per-queue allow-list reads a group whose members it covers. Each group is redacted to the members the caller may read: \`authorize\` is asked \`queues.read\` about each member queue (its queues with a share, every \`openedBy\` queue, and the queues of its controllers in the API's process) as \`GET /queues/{queue}/summon\` asks it, and a refused member's share and the \`openedBy\` of a circuit it opened are left out; the counts, limits and circuits' state stay, as they govern every member. A group none of whose members the caller may read is answered as an unknown one: the denial of \`queues.read\` asked without a queue, else the same 409 — so its existence does not leak. A \`:group\` that is not a valid name is 400 \`INVALID_NAME\` only to a caller that untargeted question allows.`,
      tags: ["Queues"],
      params: SummonGroupParams,
      responses: { 200: SummonGroupStatusSchema },
      errors: ["INVALID_NAME", "SUMMON_NOT_CONFIGURED", "DRIVER_ERROR"],
      authorizesItself: true,
      handler: async ({ req, params, services }) => {
        const name = await groupName(
          services,
          req,
          params.group,
          "queues.read",
          GROUP_READ_ROUTE,
        );
        const { driver, namespace } = services.config;
        const group = await readStoredGroupStatus(
          driver,
          namespace,
          name,
          Date.now(),
          localGroupView(services, name),
        );
        const untargeted = untargetedReadAsker(services, req, GROUP_READ_ROUTE);
        const [shown] =
          group === undefined
            ? [undefined]
            : await visibleGroups(services, req, [group], untargeted);
        if (shown === undefined) {
          // Unknown, or nothing in it the caller may read: answered alike,
          // the untargeted question's denial or the 409.
          const decision = await untargeted();
          if (!decision.allow) {
            throw denialError(decision);
          }
          throw groupNotConfigured(name);
        }
        return { body: toSummonGroupStatusDto(shown) };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/summon/groups/:group/reset",
      operationId: "resetSummonGroup",
      action: "queues.summon",
      mode: "jobs",
      requires: DRIVER_FEATURES.summonRemoteStatus,
      summary: "Clear a summon group's shared circuit or budget usage",
      description: `Resets a summon group's shared state, for every queue in it, in every process: with \`{ "circuit": true }\` its shared circuit closes and its counts clear, for every provider kind; with \`{ "budget": true }\` its attempts this UTC hour and day, and every queue's share, go to 0. \`{}\` changes nothing. Answers the group's status after it. Needs a controller in the group running in the API's process — the same rule as resetting a queue — or 409 \`SUMMON_NOT_CONFIGURED\`; 409 \`SUMMON_MARKER_CONTENDED\` when other controllers won every write it tried. Each queue's own state is untouched: \`POST /queues/{queue}/summon/reset\` resets that.\n\n\`queues.summon\`, like "summon now": opt-in, and removed by \`readOnly\`. Asked about **every member queue** — its queues with a share, every \`openedBy\` queue, and the queues of its controllers in the API's process — and needed on all of them, since the reset clears state that governs each: any refusal is answered (401/403, naming no queue) before anything is written. A group with no member is asked about without a queue. The status it answers is redacted as \`GET /summon/groups/{group}\` redacts it.`,
      tags: ["Queues"],
      params: SummonGroupParams,
      body: SummonGroupResetBodySchema,
      bodyOptional: true,
      responses: { 200: SummonGroupStatusSchema },
      errors: [
        "INVALID_NAME",
        "SUMMON_NOT_CONFIGURED",
        "SUMMON_MARKER_CONTENDED",
        "DRIVER_ERROR",
      ],
      authorizesItself: true,
      handler: async ({ req, params, body, services }) => {
        const name = await groupName(
          services,
          req,
          params.group,
          "queues.summon",
          GROUP_RESET_ROUTE,
        );
        const { driver, namespace } = services.config;
        // Every member: the reset clears state that governs each of them.
        const members = groupMembers(
          services,
          name,
          await readStoredGroupStatus(driver, namespace, name, Date.now()),
          { local: true },
        );
        if (members.length === 0) {
          await requireUntargeted(
            services,
            req,
            "queues.summon",
            GROUP_RESET_ROUTE,
          );
        } else {
          const decisions = await mapBounded(
            members,
            async (queue) =>
              await decide(services.config, req, {
                action: "queues.summon",
                transport: "http",
                queue,
                route: GROUP_RESET_ROUTE,
              }),
          );
          const refused = decisions.find(
            (decision): decision is Extract<AuthDecision, { allow: false }> =>
              !decision.allow,
          );
          if (refused !== undefined) {
            // Not naming the queue: the caller may not be allowed to read it.
            throw denialError(refused);
          }
        }
        const view = localGroupView(services, name);
        if (view.local === undefined) {
          throw groupResetNotConfigured(name);
        }
        const landed = await resetGroup(driver, namespace, name, {
          budget: body.budget === true,
          ...(body.circuit === true ? { circuit: true as const } : {}),
        });
        if (!landed) {
          throw new ApiError(
            "SUMMON_MARKER_CONTENDED",
            409,
            `Could not reset summon group "${name}": other controllers kept writing it; try again`,
            { context: { group: name } },
          );
        }
        const group = await readStoredGroupStatus(
          driver,
          namespace,
          name,
          Date.now(),
          view,
        );
        // Answered as the caller may read it: `queues.summon` on a queue is
        // not `queues.read` on it.
        const ask = summonReadAsker(services, req);
        const shown = groupMembers(services, name, group, { local: false });
        const allowed = await mapBounded(shown, ask);
        return {
          body: toSummonGroupStatusDto(
            redactGroup(
              group!,
              new Set(shown.filter((_, index) => allowed[index])),
            ),
          ),
        };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/queues/:queue/summon",
      operationId: "summonQueue",
      action: "queues.summon",
      mode: "jobs",
      summary: "Summon now: run one summon check at once",
      description: `Runs one check of the queue's summon controller now, as \`controller.check({ reason: "manual", force })\`, and answers what it did. \`force\` (default \`true\`) skips the cooldown only: the circuit, the budget, attempts already on their way and live workers still hold an attempt back, answered as \`skipped\` with the guard's \`reason\` — so this never starts compute a queue does not need. A check that summons calls the platform and waits for its answer, up to the policy's \`summonTimeout\`.\n\n\`queues.summon\` is opt-in (off unless \`actions\` names it) and a mutation (\`readOnly\` removes it): it can spend money.\n\n${SUMMON_NOTE}`,
      tags: ["Queues"],
      params: QueueParams,
      body: SummonNowBodySchema,
      bodyOptional: true,
      responses: { 200: SummonCheckSchema },
      errors: SUMMON_ERRORS,
      target: ({ params }) => queueTarget(params.queue),
      handler: async ({ params, body, services }) => {
        const controller = await services.queues.summonController(params.queue);
        const result = await controller.check({
          reason: "manual",
          force: body.force,
        });
        return { body: toSummonCheckDto(result, controller.queue) };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/queues/:queue/summon/reset",
      operationId: "resetQueueSummon",
      action: "queues.summon",
      mode: "jobs",
      summary: "Clear a queue's summon failures, backoff and open circuit",
      description: `Resets the queue's shared summon state as \`controller.reset({ budget })\` does: consecutive failures to 0, the backoff and an open circuit cleared, attempts in flight kept, and — with \`{ "budget": true }\` — the attempts counted against the budget this UTC hour and day set to 0 in the same write (\`/meta.features.summonResetBudget\` advertises the body). Without a body, or with \`budget\` false, the budget usage is kept. Answers the status after it. 409 \`SUMMON_MARKER_CONTENDED\` when other controllers won every write it tried; try again.\n\n\`queues.summon\`, like "summon now": opt-in, and removed by \`readOnly\`.\n\n${SUMMON_NOTE}`,
      tags: ["Queues"],
      params: QueueParams,
      body: SummonResetBodySchema,
      bodyOptional: true,
      responses: { 200: SummonStatusSchema },
      errors: [...SUMMON_ERRORS, "SUMMON_MARKER_CONTENDED"],
      target: ({ params }) => queueTarget(params.queue),
      handler: async ({ req, params, body, services }) => {
        const controller = await services.queues.summonController(params.queue);
        await controller.reset({ budget: body.budget });
        return {
          body: toSummonStatusDto(
            await withVisibleGroup(
              services,
              req,
              await controller.status(),
              controller.queue,
            ),
            services.config.serialize,
          ),
        };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/queues/:queue/pause",
      operationId: "pauseQueue",
      action: "queues.pause",
      mode: "jobs",
      summary: "Stop every worker in every process claiming from the queue",
      tags: ["Queues"],
      params: QueueParams,
      responses: { 200: PausedSchema },
      errors: QUEUE_ERRORS,
      target: ({ params }) => queueTarget(params.queue),
      handler: async ({ params, services }) => {
        await (await services.queues.get(params.queue)).pause();
        return { body: { paused: true } };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/queues/:queue/resume",
      operationId: "resumeQueue",
      action: "queues.resume",
      mode: "jobs",
      summary: "Let workers claim from the queue again",
      tags: ["Queues"],
      params: QueueParams,
      responses: { 200: PausedSchema },
      errors: QUEUE_ERRORS,
      target: ({ params }) => queueTarget(params.queue),
      handler: async ({ params, services }) => {
        await (await services.queues.get(params.queue)).resume();
        return { body: { paused: false } };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/queues/:queue/drain",
      operationId: "drainQueue",
      action: "queues.drain",
      mode: "jobs",
      summary: "Drop the queue's pending jobs",
      description:
        "Removes waiting jobs, and delayed ones with `delayed: true`. Never touches a job a worker is running.",
      tags: ["Queues"],
      params: QueueParams,
      body: DrainBodySchema,
      bodyOptional: true,
      responses: { 200: CountResultSchema },
      errors: QUEUE_ERRORS,
      target: ({ params }) => queueTarget(params.queue),
      handler: async ({ params, body, services }) => {
        const queue = await services.queues.get(params.queue);
        const count = await queue.drain({ delayed: body.delayed });
        // A queue can leave the backend's list with its last job, so the
        // membership cache must not answer from before this.
        services.queues.invalidate();
        return { body: { count } };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/queues/:queue/clean",
      operationId: "cleanQueue",
      action: "queues.clean",
      mode: "jobs",
      summary: "Remove jobs in one state older than a cutoff",
      tags: ["Queues"],
      params: QueueParams,
      body: cleanBodySchema(limits.maxClean),
      responses: { 200: CleanResultSchema },
      errors: QUEUE_ERRORS,
      target: ({ params }) => queueTarget(params.queue),
      handler: async ({ params, body, services }) => {
        const queue = await services.queues.get(params.queue);
        const ids = await queue.clean(body.state, {
          olderThan: body.olderThan,
          limit: body.limit,
        });
        services.queues.invalidate();
        return { body: { count: ids.length, ids } };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/queues/:queue/limits",
      operationId: "getQueueLimits",
      action: "queues.read",
      mode: "jobs",
      requires: LIMITS_METHODS,
      summary: "The queue's stored limits, or null",
      tags: ["Queues"],
      params: QueueParams,
      responses: { 200: s.nullable(StoredLimitsSchema) },
      errors: QUEUE_ERRORS,
      target: ({ params }) => queueTarget(params.queue),
      handler: async ({ params, services }) => ({
        body: await (await services.queues.get(params.queue)).getLimits(),
      }),
    }),
    defineRoute({
      method: "PUT",
      path: "/queues/:queue/limits",
      operationId: "setQueueLimits",
      action: "queues.limits",
      mode: "jobs",
      requires: LIMITS_METHODS,
      summary: "Replace the queue's limits, or remove them with null",
      description:
        "Stored on the queue, so every worker in every process enforces them; running workers adopt a change within their `limitsRefreshInterval`. 409 `LIMITS_CONTENDED` means the stored limits kept changing underneath: retry.",
      tags: ["Queues"],
      params: QueueParams,
      body: s.nullable(QueueLimitsInputSchema),
      responses: { 200: s.nullable(StoredLimitsSchema) },
      errors: [...QUEUE_ERRORS, "INVALID_ARGUMENT", "LIMITS_CONTENDED"],
      target: ({ params }) => queueTarget(params.queue),
      handler: async ({ params, body, services }) => {
        const queue = await services.queues.get(params.queue);
        if (body !== null) {
          // Refuses bad input (400, with the message that describes it)
          // before the call whose own ConfigError can then only mean
          // contention.
          try {
            normalizeLimits(body);
          } catch (error) {
            throw mapCallSiteError(error, "limitsInput");
          }
        }
        try {
          await queue.setLimits(body);
        } catch (error) {
          throw mapCallSiteError(error, "setLimits");
        }
        return { body: await queue.getLimits() };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/queues/:queue/job-defaults",
      operationId: "getJobDefaults",
      action: "queues.read",
      mode: "jobs",
      requires: DRIVER_FEATURES.jobDefaults,
      summary: "The queue's job defaults: effective, code and stored override",
      description: `What a job added now gets (\`effective\`), what this API's queue's code asks for (\`code\`, \`codeSource: "api"\`: another producer may be built with other \`defaultJobOptions\`), and the stored override with its \`seq\`. \`pending\` counts the four states the apply action walks — an upper bound on what it would change; apply with \`dryRun\` for the exact figure.\n\n${JOB_DEFAULTS_NOTE}\n\nServed where \`features.jobDefaults\` is true (every built-in driver); pruned elsewhere, never a 501.`,
      tags: ["Queues"],
      params: QueueParams,
      responses: { 200: JobDefaultsSchema },
      errors: QUEUE_ERRORS,
      target: ({ params }) => queueTarget(params.queue),
      handler: async ({ params, services }) => {
        const queue = await services.queues.get(params.queue);
        return {
          body: await jobDefaultsBody(queue, await queue.getJobDefaults()),
        };
      },
    }),
    defineRoute({
      method: "PUT",
      path: "/queues/:queue/job-defaults",
      operationId: "setJobDefaults",
      action: "queues.defaults",
      mode: "jobs",
      requires: DRIVER_FEATURES.jobDefaults,
      summary: "Merge settings into the queue's stored job defaults",
      description: `A **merge patch**: a key left out is untouched, and \`null\` clears it so the code's value applies again. Each value is bounded by \`JOB_DEFAULTS_BOUNDS\` (400 \`VALIDATION\`, the issue on the field); \`backoff\` may name only \`fixed\` or \`exponential\`, and \`keepLogs: 0\` (keep every line) is refused. Send \`expectedSeq\` for a safe read-modify-write: 409 \`CONTROL_CONTENDED\` when somebody wrote first, and nothing is changed. Answers the defaults after the write.\n\n${JOB_DEFAULTS_NOTE}\n\nOff by default: enabled only when the \`actions\` allow-list names \`queues.defaults\`.`,
      tags: ["Queues"],
      params: QueueParams,
      body: JobDefaultsBodySchema,
      responses: { 200: JobDefaultsSchema },
      errors: [...QUEUE_ERRORS, "INVALID_ARGUMENT", "CONTROL_CONTENDED"],
      target: ({ params }) => queueTarget(params.queue),
      handler: async ({ params, body, services }) => {
        const queue = await services.queues.get(params.queue);
        const update: JobDefaultsUpdate = {};
        for (const key of JOB_DEFAULT_KEYS) {
          const value = body[key];
          if (value !== undefined) {
            (update as Record<string, unknown>)[key] = value;
          }
        }
        checkJobDefaultsBody(update);
        let result;
        try {
          result = await queue.setJobDefaults(update, {
            ...(body.expectedSeq === undefined
              ? {}
              : { expectedSeq: body.expectedSeq }),
          });
        } catch (error) {
          throw mapCallSiteError(error, "jobDefaults");
        }
        if (result.contended) {
          refuseContended(queue.name, result);
        }
        return { body: await jobDefaultsBody(queue, result) };
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/queues/:queue/job-defaults",
      operationId: "resetJobDefaults",
      action: "queues.defaults",
      mode: "jobs",
      requires: DRIVER_FEATURES.jobDefaults,
      summary: "Clear the queue's stored job defaults",
      description: `Jobs added from now on get the code's values again. The override is emptied rather than deleted — a deleted entry's version would restart at 1, and an apply pinned to an older \`seq\` could then look current — so this answers 200 with the new \`seq\`, not 204. \`?expectedSeq=\` refuses the reset with 409 \`CONTROL_CONTENDED\` when somebody wrote since. **Jobs already pending keep what they were given**, including every job the apply action rewrote.\n\n${JOB_DEFAULTS_NOTE}\n\nOff by default: enabled only when the \`actions\` allow-list names \`queues.defaults\`.`,
      tags: ["Queues"],
      params: QueueParams,
      query: ResetJobDefaultsQuerySchema,
      responses: { 200: JobDefaultsSchema },
      errors: [...QUEUE_ERRORS, "CONTROL_CONTENDED"],
      target: ({ params }) => queueTarget(params.queue),
      handler: async ({ params, query, services }) => {
        const queue = await services.queues.get(params.queue);
        let result;
        try {
          result = await queue.resetJobDefaults({
            ...(query.expectedSeq === undefined
              ? {}
              : { expectedSeq: query.expectedSeq }),
          });
        } catch (error) {
          throw mapCallSiteError(error, "jobDefaults");
        }
        if (result.contended) {
          refuseContended(queue.name, result);
        }
        return { body: await jobDefaultsBody(queue, result) };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/queues/:queue/job-defaults/apply",
      operationId: "applyJobDefaults",
      action: "queues.applyDefaults",
      mode: "jobs",
      requires: DRIVER_FEATURES.jobDefaultsApply,
      summary: "Rewrite pending jobs with the stored job defaults",
      description: `One bounded call of a resumable walk: examines at most \`limit\` jobs (at most \`limits.maxApplyDefaults\`) of \`waiting\`, \`delayed\`, \`failed\` and \`waiting-children\` (or \`states\`), in claim order, and answers \`next\`; loop, sending it as \`cursor\`, until \`done\`. \`active\`, \`completed\` and \`dead\` are never touched, and a job claimed meanwhile is skipped, never half-written.\n\nOnly keys the override sets are written (\`keys\` narrows them), never a key the job's own \`add()\` passed; a job added before bun-jobs recorded that is skipped (\`skippedUnmarked\`) unless \`includeUnmarked\`. \`seq\` pins the version confirmed: 409 \`DEFAULTS_CHANGED\` when the override has moved on, writing nothing, so a walk applies one version or stops. An override that sets nothing, a key it does not set, a repeated state or a cursor this walk did not issue is 400 \`INVALID_ARGUMENT\`. \`dryRun\` walks and counts identically and writes nothing. Lowering \`attempts\` below a job's \`attemptsMade\` is written and counted \`exhausted\`: that job runs once more and dies if it fails. A \`priority\` change reorders the backlog as it goes. One apply per queue runs at a time in this process: another is 409 \`OPERATION_IN_PROGRESS\`.\n\n${JOB_DEFAULTS_NOTE}\n\nServed where \`features.jobDefaultsApply\` is true; pruned elsewhere, never a 501. Off by default: enabled only when the \`actions\` allow-list names \`queues.applyDefaults\` — a dry run is still this action, since it walks the backlog.`,
      tags: ["Queues"],
      params: QueueParams,
      body: applyJobDefaultsBodySchema(limits.maxApplyDefaults),
      responses: { 200: ApplyJobDefaultsResultSchema },
      errors: [
        ...QUEUE_ERRORS,
        "INVALID_ARGUMENT",
        "DEFAULTS_CHANGED",
        "OPERATION_IN_PROGRESS",
      ],
      target: ({ params }) => queueTarget(params.queue),
      handler: async ({ params, body, services }) => {
        const queue = await services.queues.get(params.queue);
        let running = APPLY_DEFAULTS_RUNNING.get(services);
        if (!running) {
          running = new Set();
          APPLY_DEFAULTS_RUNNING.set(services, running);
        }
        if (running.has(queue.name)) {
          throw new ApiError(
            "OPERATION_IN_PROGRESS",
            409,
            `Job defaults are already being applied on queue "${queue.name}"`,
            { context: { queue: queue.name } },
          );
        }
        running.add(queue.name);
        try {
          const result = await queue.applyJobDefaults({
            seq: body.seq,
            ...(body.keys === undefined ? {} : { keys: body.keys }),
            ...(body.states === undefined ? {} : { states: body.states }),
            limit: body.limit,
            ...(body.cursor === undefined ? {} : { cursor: body.cursor }),
            dryRun: body.dryRun,
            includeUnmarked: body.includeUnmarked,
          });
          const answer: ApplyJobDefaultsResultDto = {
            seq: result.seq,
            keys: result.keys,
            dryRun: result.dryRun,
            examined: result.examined,
            rewritten: result.rewritten,
            unchanged: result.unchanged,
            skippedExplicit: result.skippedExplicit,
            skippedUnmarked: result.skippedUnmarked,
            moved: result.moved,
            exhausted: result.exhausted,
            next: result.next,
            done: result.next === null,
          };
          return { body: answer };
        } catch (error) {
          throw mapCallSiteError(error, "jobDefaults");
        } finally {
          running.delete(queue.name);
        }
      },
    }),
    defineRoute({
      method: "GET",
      path: "/queues/:queue/throughput",
      operationId: "getQueueThroughput",
      action: "metrics.read",
      mode: "jobs",
      requires: ["getThroughput"],
      summary: "Jobs completed and attempts failed, a minute per bucket",
      description:
        "Buckets run from the oldest minute asked for to the current one, which is still filling. A backend that cannot count them has this route pruned, so it never answers 501.\n\nSuperseded by `GET /queues/{queue}/analytics/jobs`. `minutes` is deprecated: `from`/`to`, when given, decide the window instead — **`to` exclusive, the response's `to` the start of the last minute** — clamped to what is kept and 400 `RANGE_NOT_RETAINED` when wholly older. This route always answers a minute per bucket; `resolution` is accepted and, as everywhere, only a hint.",
      tags: ["Queues"],
      params: QueueParams,
      query: minutesQuerySchema(MAX_THROUGHPUT_MINUTES),
      responses: { 200: ThroughputSchema },
      errors: [...QUEUE_ERRORS, "INVALID_ARGUMENT", "RANGE_NOT_RETAINED"],
      target: ({ params }) => queueTarget(params.queue),
      handler: async ({ params, query, services }) => {
        const queue = await services.queues.get(params.queue);
        const window = minuteWindow(query);
        return {
          body: window
            ? await windowThroughput(services, queue, window)
            : await queue.getThroughput({ minutes: query.minutes }),
        };
      },
    }),
  ];
}
