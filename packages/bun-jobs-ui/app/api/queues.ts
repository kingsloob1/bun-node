import type { QueryKey } from "@tanstack/react-query";
import type { ApiClient, QueryParams } from "./client";
import type { JobState } from "./contract";
import type {
  BulkPromoteResultDto,
  BulkRemoveResultDto,
  BulkRetryResultDto,
  CleanQueueBody,
  CleanResultDto,
  CountResultDto,
  DisableRepeatableResultDto,
  EnableRepeatableResultDto,
  JobCountsDto,
  JobPageDto,
  QueueDetailDto,
  QueueLimitsBody,
  QueueLimitsDto,
  QueueListDto,
  QueueListQuery,
  QueuePausedDto,
  QueueThroughputDto,
  RepeatableListDto,
  RetryAllBody,
  RetryAllResultDto,
  WorkerListDto,
} from "./types";
import { segment } from "./client";
import { queryKeys } from "./queryKeys";

/**
 * The queue screens' calls and query keys.
 *
 * Every key about one queue sits under `queryKeys.queue(q)` (`["queue", q]`),
 * so one invalidation refreshes the whole screen; the paged queue list sits
 * under `["queues"]`. After any mutation, {@link mutationInvalidations}
 * names what to refresh.
 */

/** The filters of one jobs page, as they form its query key. */
export interface JobListFilters {
  /** The state tab, or `null` for every state. */
  state: JobState | null;
  /** Rows skipped. */
  offset: number;
  /** Rows per page. */
  limit: number;
  /** Order within the states. */
  order: "asc" | "desc";
  /** Exact names, or empty for any. */
  names: readonly string[];
  /** Id/name substring, or `""` for none. */
  search: string;
  /** Whether to ask for `page.total`. */
  total: boolean;
}

/** Query keys of the queue screens. */
export const queueKeys = {
  /** Every paged `GET /queues` read by the queue list. */
  pages: ["queues", "page"] as const,
  /** One `GET /queues` page. */
  page: (query: Required<QueueListQuery>) => ["queues", "page", query] as const,
  /** `GET /queues/:queue`. */
  detail: (queue: string) => [...queryKeys.queue(queue), "detail"] as const,
  /** `GET /queues/:queue/counts`. */
  counts: (queue: string) => [...queryKeys.queue(queue), "counts"] as const,
  /** Every jobs page of a queue. */
  jobsAll: (queue: string) => [...queryKeys.queue(queue), "jobs"] as const,
  /** One `GET /queues/:queue/jobs` page. */
  jobs: (queue: string, filters: JobListFilters) =>
    [...queryKeys.queue(queue), "jobs", filters] as const,
  /** `GET /queues/:queue/workers`. */
  workers: (queue: string) => [...queryKeys.queue(queue), "workers"] as const,
  /** `GET /queues/:queue/throughput` (the Overview's key, shared). */
  throughput: (queue: string, minutes: number) =>
    queryKeys.queueThroughput(queue, minutes),
  /** `GET /queues/:queue/repeatables?include=data`. */
  repeatables: (queue: string) =>
    [...queryKeys.queue(queue), "repeatables"] as const,
};

/** What every mutation on a queue invalidates: the queue, every queue list, and the overview. */
export function mutationInvalidations(queue: string): QueryKey[] {
  return [queryKeys.queue(queue), queryKeys.queuesAll, ["overview"]];
}

/** The app path of one job (each segment percent-encoded as `segment()` does). */
export function jobPath(queue: string, id: string): string {
  return `/queues/${segment(queue)}/jobs/${segment(id)}`;
}

/** The app path of one queue. */
export function queuePath(queue: string): string {
  return `/queues/${segment(queue)}`;
}

/** The API path of a queue, plus an optional suffix. */
function base(queue: string, suffix = ""): string {
  return `/queues/${segment(queue)}${suffix}`;
}

/** Turns jobs-list filters into the request's query: only what differs from the API's defaults, arrays as repeated keys, never `include`. */
export function jobListQuery(filters: JobListFilters): QueryParams {
  return {
    state: filters.state === null ? undefined : [filters.state],
    offset: filters.offset > 0 ? filters.offset : undefined,
    limit: filters.limit,
    order: filters.order === "desc" ? "desc" : undefined,
    name: filters.names.length > 0 ? filters.names : undefined,
    search: filters.search || undefined,
    total: filters.total ? true : undefined,
  };
}

/** `GET /queues`, one page, with a case-insensitive name `search`. */
export function listQueuesPage(
  api: ApiClient,
  query: Required<QueueListQuery>,
  signal?: AbortSignal,
): Promise<QueueListDto> {
  return api.request<QueueListDto>("GET", "/queues", {
    query: {
      search: query.search || undefined,
      offset: query.offset > 0 ? query.offset : undefined,
      limit: query.limit,
    },
    signal,
  });
}

/** `GET /queues/:queue`. */
export function getQueue(
  api: ApiClient,
  queue: string,
  signal?: AbortSignal,
): Promise<QueueDetailDto> {
  return api.request<QueueDetailDto>("GET", base(queue), { signal });
}

/** `GET /queues/:queue/counts`. */
export function getQueueCounts(
  api: ApiClient,
  queue: string,
  signal?: AbortSignal,
): Promise<JobCountsDto> {
  return api.request<JobCountsDto>("GET", base(queue, "/counts"), { signal });
}

/** `GET /queues/:queue/jobs`. */
export function listJobs(
  api: ApiClient,
  queue: string,
  filters: JobListFilters,
  signal?: AbortSignal,
): Promise<JobPageDto> {
  return api.request<JobPageDto>("GET", base(queue, "/jobs"), {
    query: jobListQuery(filters),
    signal,
  });
}

/** `POST /queues/:queue/pause` (bodiless). */
export function pauseQueue(api: ApiClient, queue: string) {
  return api.request<QueuePausedDto>("POST", base(queue, "/pause"));
}

/** `POST /queues/:queue/resume` (bodiless). */
export function resumeQueue(api: ApiClient, queue: string) {
  return api.request<QueuePausedDto>("POST", base(queue, "/resume"));
}

/** `POST /queues/:queue/drain`. */
export function drainQueue(api: ApiClient, queue: string, delayed: boolean) {
  return api.request<CountResultDto>("POST", base(queue, "/drain"), {
    body: { delayed },
  });
}

/** `POST /queues/:queue/clean`. */
export function cleanQueue(
  api: ApiClient,
  queue: string,
  body: CleanQueueBody,
) {
  return api.request<CleanResultDto>("POST", base(queue, "/clean"), { body });
}

/** `POST /queues/:queue/jobs/retry-all` (synchronous; may be slow). */
export function retryAllJobs(
  api: ApiClient,
  queue: string,
  body: RetryAllBody,
) {
  return api.request<RetryAllResultDto>(
    "POST",
    base(queue, "/jobs/retry-all"),
    {
      body,
    },
  );
}

/** `POST /queues/:queue/jobs/retry`. */
export function bulkRetry(
  api: ApiClient,
  queue: string,
  ids: readonly string[],
  resetAttempts: boolean,
) {
  return api.request<BulkRetryResultDto>("POST", base(queue, "/jobs/retry"), {
    body: { ids, resetAttempts },
  });
}

/** `POST /queues/:queue/jobs/remove`. */
export function bulkRemove(
  api: ApiClient,
  queue: string,
  ids: readonly string[],
) {
  return api.request<BulkRemoveResultDto>("POST", base(queue, "/jobs/remove"), {
    body: { ids },
  });
}

/** `POST /queues/:queue/jobs/promote`. */
export function bulkPromote(
  api: ApiClient,
  queue: string,
  ids: readonly string[],
) {
  return api.request<BulkPromoteResultDto>(
    "POST",
    base(queue, "/jobs/promote"),
    { body: { ids } },
  );
}

/** `PUT /queues/:queue/limits`; `null` removes them. Resolves the stored limits. */
export function setQueueLimits(
  api: ApiClient,
  queue: string,
  body: QueueLimitsBody | null,
) {
  return api.request<QueueLimitsDto | null>("PUT", base(queue, "/limits"), {
    body,
  });
}

/** `GET /queues/:queue/workers`. */
export function listQueueWorkers(
  api: ApiClient,
  queue: string,
  signal?: AbortSignal,
) {
  return api.request<WorkerListDto>("GET", base(queue, "/workers"), { signal });
}

/** `GET /queues/:queue/throughput?minutes=`. */
export function getThroughput(
  api: ApiClient,
  queue: string,
  minutes: number,
  signal?: AbortSignal,
): Promise<QueueThroughputDto> {
  return api.getQueueThroughput(queue, minutes, signal);
}

/** `GET /queues/:queue/repeatables?include=data`. */
export function listRepeatables(
  api: ApiClient,
  queue: string,
  signal?: AbortSignal,
) {
  return api.request<RepeatableListDto>("GET", base(queue, "/repeatables"), {
    query: { include: ["data"] },
    signal,
  });
}

/** `DELETE /queues/:queue/repeatables/:key`. */
export function removeRepeatable(api: ApiClient, queue: string, key: string) {
  return api.request<void>(
    "DELETE",
    base(queue, `/repeatables/${segment(key)}`),
  );
}

/** `POST /queues/:queue/repeatables/:key/disable`: idempotent; 404 for an unknown series. */
export function disableRepeatable(api: ApiClient, queue: string, key: string) {
  return api.request<DisableRepeatableResultDto>(
    "POST",
    base(queue, `/repeatables/${segment(key)}/disable`),
  );
}

/** `POST /queues/:queue/repeatables/:key/enable`: idempotent; 404 for an unknown series. */
export function enableRepeatable(api: ApiClient, queue: string, key: string) {
  return api.request<EnableRepeatableResultDto>(
    "POST",
    base(queue, `/repeatables/${segment(key)}/enable`),
  );
}
