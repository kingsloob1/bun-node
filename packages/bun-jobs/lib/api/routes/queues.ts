import type { BunQueue } from "../../queue/BunQueue";
import type { ResolvedJobsApiConfig } from "../config";
import type { QueueSummaryDto } from "../serialize";
import type { AnyRouteDef, RouteServices } from "./define";
import {
  supportsWorkers,
  THROUGHPUT_BUCKET_MS,
  THROUGHPUT_RETENTION_MS,
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
  QueueListQuerySchema,
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
 * Summaries of the reachable queues whose name contains `search`, at most
 * `limits.maxQueues` of them, read `FAN_OUT` queues at a time.
 */
async function summarizeQueues(
  services: RouteServices,
  search?: string,
): Promise<{ items: QueueSummaryDto[]; truncated: boolean }> {
  const names = (await services.queues.names()).filter(
    (name) => !search || name.includes(search),
  );
  const max = services.config.limits.maxQueues;
  const chosen = names.slice(0, max);

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
  return { items, truncated: names.length > max };
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

/** What finished across the queues summarised, when the driver counts it. */
async function overviewThroughput(
  services: RouteServices,
  names: readonly string[],
  minutes: number,
): Promise<{
  throughput?: { minutes: number; completed: number; failed: number };
}> {
  if (!driverImplements(services.config.driver, ["getThroughput"])) {
    return {};
  }
  const reads = await mapBounded(names, async (name) => {
    return await (await services.queues.get(name)).getThroughput({ minutes });
  });
  return {
    throughput: {
      minutes,
      completed: reads.reduce((sum, read) => sum + read.completed, 0),
      failed: reads.reduce((sum, read) => sum + read.failed, 0),
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
        "Sums the counts of up to `limits.maxQueues` queues; `truncated` says when there were more. `workers` and `throughput` are present only where the backend keeps them.",
      tags: ["Queues"],
      query: minutesQuerySchema(MAX_THROUGHPUT_MINUTES),
      responses: { 200: OverviewSchema },
      handler: async ({ query, services }) => {
        const { items, truncated } = await summarizeQueues(services);
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
        "At most `limits.maxQueues` queues, sorted by name; `truncated` says when there were more.",
      tags: ["Queues"],
      query: QueueListQuerySchema,
      responses: { 200: QueueListSchema },
      handler: async ({ query, services }) => ({
        body: await summarizeQueues(services, query.search),
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
