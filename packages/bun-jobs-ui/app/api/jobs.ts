import type { QueryKey } from "@tanstack/react-query";
import type { ApiClient } from "./client";
import type {
  AddJobBody,
  AddJobResultDto,
  ChildrenDto,
  DefinitionListDto,
  FailJobResultDto,
  JobDto,
  JobInclude,
  JobState,
  LogPageDto,
  PromoteJobResultDto,
  RetryJobResultDto,
  SortOrder,
  UpdateJobBody,
} from "./types";
import { segment } from "./client";
import { queryKeys } from "./queryKeys";
import { assertShape, hasStrings, isJobState } from "./shape";

/**
 * One job's reads and writes (`/queues/:queue/jobs/:id*`, adding a job, and
 * `/definitions`), with their query keys.
 *
 * Every key lives under `queryKeys.queue(q)`, so invalidating a queue
 * refreshes its jobs too. Job ids are arbitrary text (up to 1024 characters,
 * `/` and spaces included): each is percent-encoded as ONE path segment.
 */

/** What `GET /queues/:queue/jobs/:id` includes by default (the API's own default, sent explicitly). */
export const DEFAULT_JOB_INCLUDE: readonly JobInclude[] = [
  "data",
  "returnValue",
  "opts",
];

/** States a job does not leave on its own: polling stops there. */
export const FINISHED_STATES: ReadonlySet<JobState> = new Set<JobState>([
  "completed",
  "failed",
  "dead",
]);

/** Whether a job has finished (completed, failed or dead). */
export function isFinished(state: JobState): boolean {
  return FINISHED_STATES.has(state);
}

/** The window and order of one log page. */
export interface LogsWindow {
  /** Lines skipped. */
  offset: number;
  /** Page size, at most `limits.maxLogPage`. */
  limit: number;
  /** Oldest (`asc`) or newest (`desc`) first. */
  order: SortOrder;
}

/** Query keys of one job, all under `["queue", q]`. */
export const jobKeys = {
  /** Everything about one job: `["queue", q, "job", id]`. */
  job: (queue: string, id: string) =>
    [...queryKeys.queue(queue), "job", id] as const,
  /** The job with its stack traces (the lazy section). */
  stacktrace: (queue: string, id: string) =>
    [...jobKeys.job(queue, id), "stacktrace"] as const,
  /** One page of its logs. */
  logs: (queue: string, id: string, window: LogsWindow) =>
    [
      ...jobKeys.job(queue, id),
      "logs",
      { offset: window.offset, limit: window.limit, order: window.order },
    ] as const,
  /** Its flow children. */
  children: (queue: string, id: string) =>
    [...jobKeys.job(queue, id), "children"] as const,
  /** `GET /definitions`. */
  definitions: () => ["definitions"] as const,
};

/**
 * What every job mutation invalidates: the queue (its lists and this job),
 * every queue list, and the overview.
 */
export function mutationInvalidation(queue: string): QueryKey[] {
  return [queryKeys.queue(queue), queryKeys.queuesAll, ["overview"]];
}

/** `/queues/:queue/jobs/:id`, each part percent-encoded. */
export function jobPath(queue: string, id: string): string {
  return `/queues/${segment(queue)}/jobs/${segment(id)}`;
}

/** The app path of a job's screen. */
export function jobScreenPath(queue: string, id: string): string {
  return `/queues/${encodeURIComponent(queue)}/jobs/${encodeURIComponent(id)}`;
}

/** The app path of a queue's screen. */
export function queueScreenPath(queue: string): string {
  return `/queues/${encodeURIComponent(queue)}`;
}

/** Whether a body has what a job screen cannot draw without: string `id`, `name` and `queue`, and a known `state`. */
export function isJobShape(fields: Readonly<Record<string, unknown>>): boolean {
  return hasStrings(fields, "id", "name", "queue") && isJobState(fields.state);
}

/**
 * `GET /queues/:queue/jobs/:id`. A body that is not a job (see
 * {@link isJobShape}) rejects with an `UNEXPECTED_RESPONSE` `ApiError`, so the
 * screen shows its error state rather than an empty job.
 */
export async function getJob(
  api: ApiClient,
  queue: string,
  id: string,
  include: readonly JobInclude[] = DEFAULT_JOB_INCLUDE,
  signal?: AbortSignal,
): Promise<JobDto> {
  const path = jobPath(queue, id);
  const body = await api.request<unknown>("GET", path, {
    query: { include },
    signal,
  });
  return assertShape<JobDto>(body, isJobShape, "a job", path);
}

/** `GET /queues/:queue/jobs/:id/logs`. */
export function getJobLogs(
  api: ApiClient,
  queue: string,
  id: string,
  window: LogsWindow,
  signal?: AbortSignal,
): Promise<LogPageDto> {
  return api.request<LogPageDto>("GET", `${jobPath(queue, id)}/logs`, {
    query: {
      offset: window.offset,
      limit: window.limit,
      order: window.order,
    },
    signal,
  });
}

/** `GET /queues/:queue/jobs/:id/children`, with no include (the default). */
export function getJobChildren(
  api: ApiClient,
  queue: string,
  id: string,
  signal?: AbortSignal,
): Promise<ChildrenDto> {
  return api.request<ChildrenDto>("GET", `${jobPath(queue, id)}/children`, {
    signal,
  });
}

/** `PATCH /queues/:queue/jobs/:id`. */
export function updateJob(
  api: ApiClient,
  queue: string,
  id: string,
  body: UpdateJobBody,
): Promise<JobDto> {
  return api.request<JobDto>("PATCH", jobPath(queue, id), { body });
}

/** `DELETE /queues/:queue/jobs/:id` (204). */
export async function removeJob(
  api: ApiClient,
  queue: string,
  id: string,
): Promise<void> {
  await api.request<undefined>("DELETE", jobPath(queue, id));
}

/** `POST /queues/:queue/jobs/:id/retry`. */
export function retryJob(
  api: ApiClient,
  queue: string,
  id: string,
  resetAttempts: boolean,
): Promise<RetryJobResultDto> {
  return api.request<RetryJobResultDto>("POST", `${jobPath(queue, id)}/retry`, {
    body: { resetAttempts },
  });
}

/** `POST /queues/:queue/jobs/:id/promote` (bodiless; the client still sends the JSON content type). */
export function promoteJob(
  api: ApiClient,
  queue: string,
  id: string,
): Promise<PromoteJobResultDto> {
  return api.request<PromoteJobResultDto>(
    "POST",
    `${jobPath(queue, id)}/promote`,
  );
}

/** Longest `reason` `POST /queues/:queue/jobs/:id/fail` accepts (its schema's `maxLength`). */
export const FAIL_REASON_MAX_LENGTH = 4096;

/**
 * `POST /queues/:queue/jobs/:id/fail`: the job goes to `dead` with `reason`
 * as its failure, whatever attempts it has left. 409 for a job already
 * completed or dead.
 */
export function failJob(
  api: ApiClient,
  queue: string,
  id: string,
  reason: string,
): Promise<FailJobResultDto> {
  return api.request<FailJobResultDto>("POST", `${jobPath(queue, id)}/fail`, {
    body: { reason },
  });
}

/** `POST /queues/:queue/jobs`: 201 `added: true`, or 200 `added: false` when the `jobId` already existed. */
export function addJob(
  api: ApiClient,
  queue: string,
  body: AddJobBody,
): Promise<AddJobResultDto> {
  return api.request<AddJobResultDto>(
    "POST",
    `/queues/${segment(queue)}/jobs`,
    {
      body,
    },
  );
}

/** `GET /definitions`. */
export function listDefinitions(
  api: ApiClient,
  signal?: AbortSignal,
): Promise<DefinitionListDto> {
  return api.request<DefinitionListDto>("GET", "/definitions", { signal });
}
