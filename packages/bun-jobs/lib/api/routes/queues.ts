import type { BunQueue } from "../../queue/BunQueue";
import type { ResolvedJobsApiConfig } from "../config";
import type {
  OverviewDto,
  PageInfoDto,
  QueueThroughputDto,
  ThroughputBucketDto,
} from "../contract/types";
import type { QueueSummaryDto } from "../serialize";
import type { AnyRouteDef, RouteServices } from "./define";
import {
  supportsWorkers,
  THROUGHPUT_BUCKET_MS,
  THROUGHPUT_RETENTION_MS,
  throughputBucket,
} from "../../drivers/index";
import { normalizeLimits } from "../../queue/limits";
import { mapCallSiteError } from "../errors";
import { s } from "../schema/builder";
import { JOB_STATES } from "../schemas/common";
import {
  cleanBodySchema,
  CleanResultSchema,
  CountResultSchema,
  DrainBodySchema,
  JobCountsSchema,
  minutesQuerySchema,
  OverviewSchema,
  PausedSchema,
  QueueDetailSchema,
  QueueLimitsInputSchema,
  queueListQuerySchema,
  QueueListSchema,
  StoredLimitsSchema,
  ThroughputSchema,
  WorkerListSchema,
} from "../schemas/queues";
import { toWorkerDto } from "../serialize";
import { defineRoute } from "./define";
import { driverImplements } from "./meta";
import { mapBounded, QueueParams, queueTarget } from "./support";

/** The driver methods queue limits need. */
const LIMITS_METHODS = ["getQueueState", "setQueueState"] as const;

/** The most minutes of throughput any route reads: what a driver retains. */
const MAX_THROUGHPUT_MINUTES = THROUGHPUT_RETENTION_MS / THROUGHPUT_BUCKET_MS;

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
 * One page of summaries of the reachable queues whose name contains
 * `search` (ignoring case), sorted by name: `offset` names skipped, at most
 * `limit` (by default, and at most, `limits.maxQueues`) summarised, read
 * `FAN_OUT` queues at a time. Every path lists names the same way — through
 * `services.queues`, then this filter — whatever the driver.
 */
async function summarizeQueues(
  services: RouteServices,
  options: { search?: string; offset?: number; limit?: number } = {},
): Promise<{
  items: QueueSummaryDto[];
  truncated: boolean;
  page: PageInfoDto;
}> {
  const names = (await services.queues.names()).filter((name) =>
    queueNameMatches(name, options.search),
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
): Promise<{ workers?: number }> {
  if (!services.config.jobs || !supportsWorkers(services.config.driver)) {
    return {};
  }
  const allowed = new Set(names);
  const workers = await services.config.jobs.listWorkers();
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
): Promise<{
  throughput?: OverviewDto["throughput"];
  throughputSeries?: QueueThroughputDto;
}> {
  if (!driverImplements(services.config.driver, ["getThroughput"])) {
    return {};
  }
  const reads = await mapBounded(names, async (name) => {
    return await (await services.queues.get(name)).getThroughput({ minutes });
  });
  const to = reads.reduce(
    (latest, read) => Math.max(latest, read.to),
    throughputBucket(Date.now()),
  );
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

/** Errors every route naming a queue can answer with. */
const QUEUE_ERRORS = ["INVALID_NAME", "QUEUE_NOT_FOUND"] as const;

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
        "Sums the counts of up to `limits.maxQueues` queues; `truncated` says when there were more. `workers` and `throughput` are present only where the backend keeps them. `throughputSeries` is the namespace-wide per-minute series, in the shape of `GET /queues/{queue}/throughput`: each queue's buckets summed (read a queue at a time, 16 at once: the backend has no namespace-wide count).",
      tags: ["Queues"],
      query: minutesQuerySchema(MAX_THROUGHPUT_MINUTES),
      responses: { 200: OverviewSchema },
      handler: async ({ query, services }) => {
        const { items, truncated } = await summarizeQueues(services, {
          limit: services.config.limits.maxQueues,
        });
        const counts = Object.fromEntries(
          JOB_STATES.map((state) => [
            state,
            items.reduce((sum, item) => sum + item.counts[state], 0),
          ]),
        ) as QueueSummaryDto["counts"];
        const names = items.map((item) => item.name);
        return {
          body: {
            queues: items.length,
            pausedQueues: items.filter((item) => item.paused).length,
            counts,
            total: items.reduce((sum, item) => sum + item.total, 0),
            truncated,
            ...(await overviewWorkers(services, names)),
            ...(await overviewThroughput(services, names, query.minutes)),
          },
        };
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
        "A page of queues sorted by name: `limit` (at most, and by default, `limits.maxQueues`) after skipping `offset`. `search` keeps names containing it, ignoring case. `truncated` (the same as `page.hasMore`) says when more follow.",
      tags: ["Queues"],
      query: queueListQuerySchema(limits.maxQueues),
      responses: { 200: QueueListSchema },
      handler: async ({ query, services }) => ({
        body: await summarizeQueues(services, query),
      }),
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
      path: "/queues/:queue/workers",
      operationId: "listQueueWorkers",
      action: "workers.list",
      mode: "jobs",
      enabledWhen: (config) => supportsWorkers(config.driver),
      summary: "The workers consuming this queue, in any process",
      description:
        "Live workers only: one that stopped reporting lapses and is not listed. `host` and `pid` are omitted when `serialize.exposeHosts` is off.",
      tags: ["Queues"],
      params: QueueParams,
      responses: { 200: WorkerListSchema },
      errors: QUEUE_ERRORS,
      target: ({ params }) => queueTarget(params.queue),
      handler: async ({ params, services }) => {
        const queue = await services.queues.get(params.queue);
        const workers = await queue.listWorkers();
        return {
          body: {
            items: workers.map((worker) =>
              toWorkerDto(worker, services.config.serialize),
            ),
          },
        };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/workers",
      operationId: "listWorkers",
      action: "workers.list",
      mode: "jobs",
      needsJobsSource: true,
      enabledWhen: (config) => supportsWorkers(config.driver),
      summary: "Every worker in the namespace",
      description:
        "Across every queue this API may see, oldest first. A worker consuming a queue outside `queues` is not listed.",
      tags: ["Queues"],
      responses: { 200: WorkerListSchema },
      handler: async ({ services }) => {
        const workers = await services.config.jobs!.listWorkers();
        const allowed = new Set(await services.queues.names());
        return {
          body: {
            items: workers
              .filter((worker) => allowed.has(worker.queue))
              .map((worker) => toWorkerDto(worker, services.config.serialize)),
          },
        };
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
        "Buckets run from the oldest minute asked for to the current one, which is still filling. A backend that cannot count them has this route pruned, so it never answers 501.",
      tags: ["Queues"],
      params: QueueParams,
      query: minutesQuerySchema(MAX_THROUGHPUT_MINUTES),
      responses: { 200: ThroughputSchema },
      errors: QUEUE_ERRORS,
      target: ({ params }) => queueTarget(params.queue),
      handler: async ({ params, query, services }) => {
        const queue = await services.queues.get(params.queue);
        return { body: await queue.getThroughput({ minutes: query.minutes }) };
      },
    }),
  ];
}
