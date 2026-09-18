import type { JobState } from "../../drivers/index";
import type { BunQueue } from "../../queue/BunQueue";
import type { Job } from "../../queue/Job";
import type { ResolvedJobsApiConfig } from "../config";
import type { JobInclude } from "../serialize";
import type { AnyRouteDef, RouteContext, RouteServices } from "./define";
import { isAddableName } from "../config";
import { ApiError, mapCallSiteError } from "../errors";
import { s } from "../schema/builder";
import { JOB_STATES } from "../schemas/common";
import {
  AddBodySchema,
  AddResultSchema,
  bulkBodySchema,
  bulkRetryBodySchema,
  ChildrenSchema,
  IncludeQuerySchema,
  jobListQuerySchema,
  JobPageSchema,
  JobSchema,
  LogPageSchema,
  logsQuerySchema,
  lookupBodySchema,
  LookupResultSchema,
  RETRY_ALL_MAX_IDS,
  retryAllBodySchema,
  RetryAllResultSchema,
  RetryBodySchema,
  UpdateBodySchema,
} from "../schemas/jobs";
import { JOB_LIST_INCLUDE, JOB_READ_INCLUDE, toJobDto } from "../serialize";
import { defineRoute } from "./define";
import {
  bulkIds,
  jobNotFound,
  JobParams,
  mapBounded,
  QueueParams,
  queueTarget,
  stateConflict,
  toEpoch,
} from "./support";

/** Retry-alls in flight, per API and queue: one at a time per queue in a process. */
const RETRY_ALL_RUNNING = new WeakMap<RouteServices, Set<string>>();

/** The include set a request asked for, or the default. */
function includeOf(
  include: readonly JobInclude[] | undefined,
  fallback: ReadonlySet<JobInclude>,
): ReadonlySet<JobInclude> {
  return include ? new Set(include) : fallback;
}

/** Serialises a job for a response. */
function dto(
  ctx: Pick<RouteContext<unknown, unknown, unknown>, "req" | "services">,
  queue: BunQueue<any, any, any>,
  job: Job<any, any>,
  include: ReadonlySet<JobInclude>,
) {
  return toJobDto(
    job.toJSON(),
    { queue: queue.name, include, req: ctx.req },
    ctx.services.config.serialize,
  );
}

/** A job that must exist: 404 otherwise. */
async function existingJob(
  queue: BunQueue<any, any, any>,
  id: string,
): Promise<Job<any, any>> {
  const job = await queue.getJob(id);
  if (!job) {
    throw jobNotFound(queue.name, id);
  }
  return job;
}

/**
 * Runs a single-job operation whose `false` means either "no such job" or
 * "wrong state", and tells the two apart: after a refusal the job is read, so
 * a missing one is 404 and a present one is 409 with the state it is in. Only
 * a refusal pays the extra read. A job that changes between the two calls
 * yields a 409 the client simply refetches.
 */
async function singleJobOperation(
  queue: BunQueue<any, any, any>,
  id: string,
  operation: string,
  run: () => Promise<boolean>,
): Promise<void> {
  if (await run()) {
    return;
  }
  const now = await queue.getJob(id);
  if (!now) {
    throw jobNotFound(queue.name, id);
  }
  throw stateConflict(operation, now.state);
}

/** Errors every route naming a queue can answer with. */
const QUEUE_ERRORS = ["INVALID_NAME", "QUEUE_NOT_FOUND"] as const;

/** Errors every route naming a job can answer with. */
const JOB_ERRORS = [...QUEUE_ERRORS, "JOB_NOT_FOUND"] as const;

/** `{ retried: true }` and its siblings. */
const done = (key: string) => s.object({ [key]: s.literal(true) });

/** A bulk result: the ids that went, and the ones that did not. */
const bulkResult = (key: "retried" | "removed" | "promoted") =>
  s.object({ [key]: s.array(s.string()), skipped: s.array(s.string()) });

/** The job routes available on every driver today. */
export function jobRoutes(config: ResolvedJobsApiConfig): AnyRouteDef[] {
  const { limits } = config;
  return [
    defineRoute({
      method: "GET",
      path: "/queues/:queue/jobs",
      operationId: "listJobs",
      action: "jobs.list",
      mode: "jobs",
      summary: "A page of the queue's jobs",
      description:
        "Offset pagination over the states asked for, in their natural order. Jobs move between states while you page, so a page can repeat or skip a job: treat it as live data. Lists omit `data`, `returnValue`, `stacktrace` and `opts` unless `include` asks for them. `stacktrace` entries (and `failedReason`) carry `stack` only with `serialize.exposeStacks`; otherwise each is the error's `name` and `message`, plus `code`, `data` and `cause` when it had them.",
      tags: ["Jobs"],
      params: QueueParams,
      query: jobListQuerySchema(limits.defaultPageSize, limits.maxPageSize),
      responses: { 200: JobPageSchema },
      errors: QUEUE_ERRORS,
      target: ({ params }) => queueTarget(params.queue),
      handler: async (ctx) => {
        const { params, query, services } = ctx;
        const queue = await services.queues.get(params.queue);
        const states: JobState[] =
          query.state && query.state.length > 0
            ? [...new Set(query.state)]
            : [...JOB_STATES];
        const include = includeOf(query.include, JOB_LIST_INCLUDE);
        // `name` and `search` filter on every backend: the queue takes the
        // driver's own query where there is one and scans where there is not.
        const filters = {
          ...(query.name && query.name.length > 0 ? { name: query.name } : {}),
          ...(query.search === undefined ? {} : { search: query.search }),
        };

        // A total has to see every match, so it is asked for only when the
        // caller wants it; `hasMore` then follows from the total rather than
        // from reading one extra job.
        if (query.total) {
          const page = await queue.page(states, {
            offset: query.offset,
            limit: query.limit,
            order: query.order,
            ...filters,
          });
          return {
            body: {
              items: page.jobs.map((job) => dto(ctx, queue, job, include)),
              page: {
                offset: query.offset,
                limit: query.limit,
                total: page.total,
                hasMore: query.offset + page.jobs.length < page.total,
              },
            },
          };
        }

        // One more than a page, so whether another follows is known without a count.
        const jobs = await queue.list(states, {
          offset: query.offset,
          limit: query.limit + 1,
          order: query.order,
          ...filters,
        });
        return {
          body: {
            items: jobs
              .slice(0, query.limit)
              .map((job) => dto(ctx, queue, job, include)),
            page: {
              offset: query.offset,
              limit: query.limit,
              hasMore: jobs.length > query.limit,
            },
          },
        };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/queues/:queue/jobs/lookup",
      operationId: "lookupJobs",
      action: "jobs.read",
      mode: "jobs",
      summary: "Several jobs by id, in the order asked",
      description:
        "A read: POST only because a long id list does not fit a URL. Missing ids answer `null` in their place.",
      tags: ["Jobs"],
      params: QueueParams,
      body: lookupBodySchema(limits.maxBulkIds),
      responses: { 200: LookupResultSchema },
      errors: [...QUEUE_ERRORS, "BULK_LIMIT"],
      target: ({ params, body }) => ({
        ...queueTarget(params.queue),
        jobIds: bulkIds(body.ids, limits.maxBulkIds),
      }),
      handler: async (ctx) => {
        const { params, body, services } = ctx;
        const queue = await services.queues.get(params.queue);
        const include = includeOf(body.include, JOB_LIST_INCLUDE);
        // One round trip where the driver has `getJobs`; `getJobsByIds` falls
        // back to a bounded `getJob` loop where it does not. Either way the
        // answer is one entry per id, in the order asked, `null` for missing.
        const jobs = await queue.getJobs(body.ids);
        return {
          body: {
            items: jobs.map((job) =>
              job ? dto(ctx, queue, job, include) : null,
            ),
          },
        };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/queues/:queue/jobs/:id",
      operationId: "getJob",
      action: "jobs.read",
      mode: "jobs",
      summary: "One job",
      description:
        "Includes `data`, `returnValue` and `opts` unless `include` narrows it; `stacktrace` only when `include` names it. `stacktrace` entries (and `failedReason`) carry `stack` only with `serialize.exposeStacks`; otherwise each is the error's `name` and `message`, plus `code`, `data` and `cause` when it had them.",
      tags: ["Jobs"],
      params: JobParams,
      query: IncludeQuerySchema,
      responses: { 200: JobSchema },
      errors: JOB_ERRORS,
      target: ({ params }) => ({
        ...queueTarget(params.queue),
        jobId: params.id,
      }),
      handler: async (ctx) => {
        const queue = await ctx.services.queues.get(ctx.params.queue);
        const job = await existingJob(queue, ctx.params.id);
        return {
          body: dto(
            ctx,
            queue,
            job,
            includeOf(ctx.query.include, JOB_READ_INCLUDE),
          ),
        };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/queues/:queue/jobs/:id/logs",
      operationId: "getJobLogs",
      action: "jobs.logs",
      mode: "jobs",
      requires: ["getJobLogs"],
      summary: "A page of a job's log lines",
      tags: ["Jobs"],
      params: JobParams,
      query: logsQuerySchema(limits.maxLogPage),
      responses: { 200: LogPageSchema },
      errors: JOB_ERRORS,
      target: ({ params }) => ({
        ...queueTarget(params.queue),
        jobId: params.id,
      }),
      handler: async ({ params, query, services }) => {
        const queue = await services.queues.get(params.queue);
        await existingJob(queue, params.id);
        const { logs, count } = await queue.getJobLogs(params.id, {
          offset: query.offset,
          limit: query.limit,
          order: query.order,
        });
        return {
          body: {
            items: logs,
            page: {
              offset: query.offset,
              limit: query.limit,
              total: count,
              hasMore: query.offset + logs.length < count,
            },
          },
        };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/queues/:queue/jobs/:id/children",
      operationId: "getJobChildren",
      action: "jobs.read",
      mode: "jobs",
      summary:
        "A job's place in a flow: its parent, and each child with its outcome",
      description:
        "Children are read from their own queues; a child in a queue this API cannot reach is listed with `job: null`. At most `limits.maxBulkIds` children are listed; `truncated` says when there were more.",
      tags: ["Jobs"],
      params: JobParams,
      query: IncludeQuerySchema,
      responses: { 200: ChildrenSchema },
      errors: JOB_ERRORS,
      target: ({ params }) => ({
        ...queueTarget(params.queue),
        jobId: params.id,
      }),
      handler: async (ctx) => {
        const { params, query, services } = ctx;
        const queue = await services.queues.get(params.queue);
        const record = (await existingJob(queue, params.id)).toJSON();
        const flow = record.flow;
        const refs = flow?.children ?? [];
        const include = includeOf(query.include, JOB_LIST_INCLUDE);
        const children = await mapBounded(
          refs.slice(0, limits.maxBulkIds),
          async (ref) => {
            const key = `${ref.queue}:${ref.id}`;
            const reachable = await services.queues.has(ref.queue);
            const childQueue = reachable
              ? await services.queues.get(ref.queue)
              : undefined;
            const child = childQueue ? await childQueue.getJob(ref.id) : null;
            const failure = flow?.failures[key];
            return {
              queue: ref.queue,
              id: ref.id,
              job:
                child && childQueue
                  ? dto(ctx, childQueue, child, include)
                  : null,
              ...(flow && Object.hasOwn(flow.values, key)
                ? { value: flow.values[key] }
                : {}),
              ...(failure
                ? {
                    failure: {
                      name: failure.name,
                      message: failure.message,
                      ...(failure.code === undefined
                        ? {}
                        : { code: failure.code }),
                      ...(services.config.serialize.exposeStacks &&
                      failure.stack !== undefined
                        ? { stack: failure.stack }
                        : {}),
                    },
                  }
                : {}),
            };
          },
        );
        return {
          body: {
            parent: flow?.parent ?? null,
            pending: flow?.pending ?? 0,
            children,
            truncated: refs.length > limits.maxBulkIds,
          },
        };
      },
    }),
    defineRoute({
      method: "PATCH",
      path: "/queues/:queue/jobs/:id",
      operationId: "updateJob",
      action: "jobs.update",
      mode: "jobs",
      requires: ["updateJob"],
      summary: "Change a stored job's data, priority or run time",
      description:
        "Off by default: enabled only when the `actions` allow-list names `jobs.update`. `runAt` moves only a waiting or delayed job; `onlyIn` makes the change conditional on the job's state. 409 means the job was in a state the change cannot apply to.",
      tags: ["Jobs"],
      params: JobParams,
      body: UpdateBodySchema,
      maxBodyBytes: limits.maxJobDataBytes,
      responses: { 200: JobSchema },
      errors: [
        ...JOB_ERRORS,
        "INVALID_ARGUMENT",
        "JOB_STATE_CONFLICT",
        "SERIALIZATION",
      ],
      target: ({ params }) => ({
        ...queueTarget(params.queue),
        jobId: params.id,
      }),
      handler: async (ctx) => {
        const { params, body, services } = ctx;
        if (
          body.data === undefined &&
          body.priority === undefined &&
          body.runAt === undefined
        ) {
          throw new ApiError(
            "INVALID_ARGUMENT",
            400,
            "Give at least one of data, priority or runAt",
          );
        }
        const queue = await services.queues.get(params.queue);
        const current = await existingJob(queue, params.id);
        let updated: Job<any, any> | null;
        try {
          updated = await queue.update(params.id, {
            ...(body.data === undefined ? {} : { data: body.data }),
            ...(body.priority === undefined ? {} : { priority: body.priority }),
            ...(body.runAt === undefined ? {} : { runAt: toEpoch(body.runAt) }),
            ...(body.onlyIn ? { onlyIn: body.onlyIn } : {}),
          });
        } catch (error) {
          throw mapCallSiteError(error, "jobInput");
        }
        if (!updated) {
          const now = await queue.getJob(params.id);
          throw stateConflict("updated", (now ?? current).state);
        }
        return { body: dto(ctx, queue, updated, JOB_READ_INCLUDE) };
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/queues/:queue/jobs/:id",
      operationId: "removeJob",
      action: "jobs.remove",
      mode: "jobs",
      summary: "Remove a job",
      description: "Refused (409 `JOB_ACTIVE`) while a worker is running it.",
      tags: ["Jobs"],
      params: JobParams,
      responses: { 204: null },
      errors: [...JOB_ERRORS, "JOB_ACTIVE", "JOB_STATE_CONFLICT"],
      target: ({ params }) => ({
        ...queueTarget(params.queue),
        jobId: params.id,
      }),
      handler: async ({ params, services }) => {
        const queue = await services.queues.get(params.queue);
        const job = await existingJob(queue, params.id);
        if (job.state === "active") {
          throw stateConflict("removed", "active", "JOB_ACTIVE");
        }
        await singleJobOperation(queue, params.id, "removed", async () => {
          return await queue.remove(params.id);
        });
        // Removing the last job can take the queue off the backend's list.
        services.queues.invalidate();
        return { status: 204 };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/queues/:queue/jobs/:id/retry",
      operationId: "retryJob",
      action: "jobs.retry",
      mode: "jobs",
      summary: "Return a finished job to the queue",
      tags: ["Jobs"],
      params: JobParams,
      body: RetryBodySchema,
      bodyOptional: true,
      responses: { 200: done("retried") },
      errors: [...JOB_ERRORS, "JOB_STATE_CONFLICT"],
      target: ({ params }) => ({
        ...queueTarget(params.queue),
        jobId: params.id,
      }),
      handler: async ({ params, body, services }) => {
        const queue = await services.queues.get(params.queue);
        await singleJobOperation(queue, params.id, "retried", async () => {
          return await queue.retry(params.id, {
            resetAttempts: body.resetAttempts,
          });
        });
        return { body: { retried: true } };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/queues/:queue/jobs/:id/promote",
      operationId: "promoteJob",
      action: "jobs.promote",
      mode: "jobs",
      summary: "Make a delayed or retry-pending job claimable now",
      tags: ["Jobs"],
      params: JobParams,
      responses: { 200: done("promoted") },
      errors: [...JOB_ERRORS, "JOB_STATE_CONFLICT"],
      target: ({ params }) => ({
        ...queueTarget(params.queue),
        jobId: params.id,
      }),
      handler: async ({ params, services }) => {
        const queue = await services.queues.get(params.queue);
        await singleJobOperation(queue, params.id, "promoted", async () => {
          return await queue.promote(params.id);
        });
        return { body: { promoted: true } };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/queues/:queue/jobs/retry",
      operationId: "retryJobs",
      action: "jobs.retry",
      mode: "jobs",
      summary: "Return several finished jobs to the queue",
      description:
        "Ids that are missing, running or already pending are skipped.",
      tags: ["Jobs"],
      params: QueueParams,
      body: bulkRetryBodySchema(limits.maxBulkIds),
      responses: { 200: bulkResult("retried") },
      errors: [...QUEUE_ERRORS, "BULK_LIMIT"],
      target: ({ params, body }) => ({
        ...queueTarget(params.queue),
        jobIds: bulkIds(body.ids, limits.maxBulkIds),
      }),
      handler: async ({ params, body, services }) => {
        const queue = await services.queues.get(params.queue);
        const ids = bulkIds(body.ids, limits.maxBulkIds);
        const retried = await queue.retryJobs(ids, {
          resetAttempts: body.resetAttempts,
        });
        const went = new Set(retried);
        return {
          body: { retried, skipped: ids.filter((id) => !went.has(id)) },
        };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/queues/:queue/jobs/remove",
      operationId: "removeJobs",
      action: "jobs.remove",
      mode: "jobs",
      summary: "Remove several jobs",
      description: "Ids that are missing or running are skipped.",
      tags: ["Jobs"],
      params: QueueParams,
      body: bulkBodySchema(limits.maxBulkIds),
      responses: { 200: bulkResult("removed") },
      errors: [...QUEUE_ERRORS, "BULK_LIMIT"],
      target: ({ params, body }) => ({
        ...queueTarget(params.queue),
        jobIds: bulkIds(body.ids, limits.maxBulkIds),
      }),
      handler: async ({ params, body, services }) => {
        const queue = await services.queues.get(params.queue);
        const ids = bulkIds(body.ids, limits.maxBulkIds);
        const outcomes = await mapBounded(ids, (id) => queue.remove(id));
        services.queues.invalidate();
        return {
          body: {
            removed: ids.filter((_id, index) => outcomes[index]),
            skipped: ids.filter((_id, index) => !outcomes[index]),
          },
        };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/queues/:queue/jobs/promote",
      operationId: "promoteJobs",
      action: "jobs.promote",
      mode: "jobs",
      summary: "Make several delayed jobs claimable now",
      description: "Ids that are missing or not delayed are skipped.",
      tags: ["Jobs"],
      params: QueueParams,
      body: bulkBodySchema(limits.maxBulkIds),
      responses: { 200: bulkResult("promoted") },
      errors: [...QUEUE_ERRORS, "BULK_LIMIT"],
      target: ({ params, body }) => ({
        ...queueTarget(params.queue),
        jobIds: bulkIds(body.ids, limits.maxBulkIds),
      }),
      handler: async ({ params, body, services }) => {
        const queue = await services.queues.get(params.queue);
        const ids = bulkIds(body.ids, limits.maxBulkIds);
        const outcomes = await mapBounded(ids, (id) => queue.promote(id));
        return {
          body: {
            promoted: ids.filter((_id, index) => outcomes[index]),
            skipped: ids.filter((_id, index) => !outcomes[index]),
          },
        };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/queues/:queue/jobs/retry-all",
      operationId: "retryAllJobs",
      action: "jobs.retryAll",
      mode: "jobs",
      summary: "Re-drive every finished job in a state that matches",
      description:
        "Walks the state a page at a time, up to `limit` jobs (at most `limits.maxRetryAll`). `reason` is a plain substring of the last failure; patterns are not accepted. One retry-all per queue runs at a time in this process: another is 409 `OPERATION_IN_PROGRESS`.",
      tags: ["Jobs"],
      params: QueueParams,
      body: retryAllBodySchema(limits.maxRetryAll),
      responses: { 200: RetryAllResultSchema },
      errors: [...QUEUE_ERRORS, "OPERATION_IN_PROGRESS"],
      target: ({ params }) => queueTarget(params.queue),
      handler: async ({ params, body, services }) => {
        const queue = await services.queues.get(params.queue);
        let running = RETRY_ALL_RUNNING.get(services);
        if (!running) {
          running = new Set();
          RETRY_ALL_RUNNING.set(services, running);
        }
        if (running.has(queue.name)) {
          throw new ApiError(
            "OPERATION_IN_PROGRESS",
            409,
            `A retry-all is already running on queue "${queue.name}"`,
            { context: { queue: queue.name } },
          );
        }
        running.add(queue.name);
        try {
          const ids = await queue.retryAll(body.state, {
            ...(body.name === undefined ? {} : { name: body.name }),
            ...(body.reason === undefined ? {} : { reason: body.reason }),
            limit: body.limit,
            resetAttempts: body.resetAttempts,
          });
          return {
            body: {
              count: ids.length,
              ids: ids.slice(0, RETRY_ALL_MAX_IDS),
              truncated: ids.length > RETRY_ALL_MAX_IDS,
            },
          };
        } finally {
          running.delete(queue.name);
        }
      },
    }),
    defineRoute({
      method: "POST",
      path: "/queues/:queue/jobs",
      operationId: "addJob",
      action: "jobs.add",
      mode: "jobs",
      summary: "Add a job",
      description:
        "Off by default: enabled only when the `actions` allow-list names `jobs.add`, and only for names in `addableNames` (by default, the defined names). Accepts a safe subset of options. A `jobId` that already exists answers 200 with the existing job and `added: false`. The queue need not exist yet: adding its first job creates it, as `BunQueue.add` does, and it is listed at once. When the API is limited to a configured list of queues, a queue outside that list is still 404 `QUEUE_NOT_FOUND`.",
      tags: ["Jobs"],
      params: QueueParams,
      body: AddBodySchema,
      maxBodyBytes: limits.maxJobDataBytes,
      responses: { 200: AddResultSchema, 201: AddResultSchema },
      errors: [...QUEUE_ERRORS, "NAME_NOT_ADDABLE", "SERIALIZATION"],
      target: ({ params }) => queueTarget(params.queue),
      handler: async (ctx) => {
        const { params, body, services } = ctx;
        if (!isAddableName(services.config, body.name)) {
          throw new ApiError(
            "NAME_NOT_ADDABLE",
            403,
            `Jobs named "${body.name}" may not be added over this API`,
            { context: { name: body.name } },
          );
        }
        // The first job added to a queue is what creates it, so an unknown
        // queue is not a 404 here: the name was checked above.
        const { queue, created } = await services.queues.getForAdd(
          params.queue,
        );
        const { runAt, ...opts } = body.opts ?? {};
        let job: Job<any, any>;
        try {
          job = await queue.add(body.name, body.data, {
            ...opts,
            ...(runAt === undefined ? {} : { runAt: toEpoch(runAt) }),
          });
        } catch (error) {
          throw mapCallSiteError(error, "jobInput");
        }
        if (created) {
          services.queues.invalidate();
        }
        return {
          status: job.wasAdded ? 201 : 200,
          body: {
            added: job.wasAdded,
            job: dto(ctx, queue, job, JOB_READ_INCLUDE),
          },
        };
      },
    }),
  ];
}
