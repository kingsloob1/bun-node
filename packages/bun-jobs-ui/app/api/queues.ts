import type { QueryKey } from "@tanstack/react-query";
import type { ApiClient, QueryParams } from "./client";
import type { JobListSort, JobState } from "./contract";
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
import { assertShape, hasStrings } from "./shape";

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
  /**
   * The job-attribution filters, or absent for none. They reach the request
   * only when {@link jobListQuery} is told `features.jobAttribution` is true:
   * an API without it refuses all four parameters (400 `VALIDATION`).
   */
  attribution?: JobAttributionFilters;
}

/**
 * The window a jobs page is read over, on `finishedOn`. Stored as what the
 * user chose, never as instants a rolling window happened to resolve to, so a
 * query key stays put while the clock moves; {@link jobListQuery} resolves it.
 */
export type FinishedWindow =
  | {
      /** A rolling window ending now. */
      kind: "last";
      /** Its length, in ms: `finishedFrom` is now minus this, with no `finishedTo`. */
      ms: number;
    }
  | {
      /** A fixed span. */
      kind: "between";
      /** `finishedFrom`, epoch ms, inclusive. */
      from: number;
      /** `finishedTo`, epoch ms, exclusive; after `from`, or the API answers 400. */
      to: number;
    };

/**
 * Which worker ran a job's last attempt (`processedBy`) and when it finished:
 * `GET /queues/:queue/jobs`' `workerKey`, `workerId`, `finishedFrom` and
 * `finishedTo`. ANDed with the other filters.
 */
export interface JobAttributionFilters {
  /**
   * Stable keys (`processedBy.key`), each sent as its own `workerKey`. The API
   * splits every value at commas, so a key holding one cannot be sent: check
   * {@link isSendableFilterValue} first.
   */
  workerKeys: readonly string[];
  /** Incarnation ids (`processedBy.id`), each its own `workerId`; the same comma rule. */
  workerIds: readonly string[];
  /**
   * The `finishedOn` window, or `null` for none. A job with no `finishedOn`
   * (waiting, delayed, active, waiting on children, failed with a retry
   * pending) never matches a window, from either end.
   */
  finished: FinishedWindow | null;
}

/**
 * Whether a value can be sent as ONE job-list filter value: the API splits
 * every value at commas, so a value holding one would become two filters.
 */
export function isSendableFilterValue(value: string): boolean {
  return value !== "" && !value.includes(",");
}

/** Options of {@link jobListQuery} and {@link listJobs}. */
export interface JobListQueryOptions {
  /**
   * `meta.features.jobAttribution`. Only when it is `true` are the
   * attribution filters sent; otherwise they are dropped, since the API
   * refuses them. Defaults to `false`.
   */
  attribution?: boolean;
  /** The clock a rolling `finished` window resolves against, epoch ms. Defaults to `Date.now()`. */
  now?: number;
  /**
   * `meta.features.addedByState`. When `true` the page is sorted by creation
   * time on every tab (`sort=createdAt`), unless the filters count the total:
   * see {@link sortsByCreation}. Otherwise no `sort` is sent and each tab
   * keeps its natural order, since an API without the feature refuses
   * `sort=createdAt` (400 `INVALID_ARGUMENT`). Defaults to `false`.
   */
  createdOrder?: boolean;
}

/**
 * Whether a page is sorted by creation time (`sort=createdAt`): only where
 * the backend serves it (`createdOrder`, `features.addedByState`) and never
 * together with `total=true`. On SQL and MongoDB a `createdAt` page of one
 * large state is a top-N sort over every job of that state, and counting it
 * walks them all again; a counted page keeps the tab's natural order instead.
 */
export function sortsByCreation(
  filters: Pick<JobListFilters, "total">,
  createdOrder: boolean | undefined,
): boolean {
  return createdOrder === true && !filters.total;
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

/**
 * Turns jobs-list filters into the request's query: only what differs from
 * the API's defaults, arrays as repeated keys, never `include`. The
 * attribution filters are added only with `options.attribution` true, and
 * `sort=createdAt` only as {@link sortsByCreation} allows.
 */
export function jobListQuery(
  filters: JobListFilters,
  options: JobListQueryOptions = {},
): QueryParams {
  const attribution =
    options.attribution === true ? filters.attribution : undefined;
  const finished = attribution?.finished ?? null;
  const now = options.now ?? Date.now();
  const sort: JobListSort | undefined = sortsByCreation(
    filters,
    options.createdOrder,
  )
    ? "createdAt"
    : undefined;
  return {
    state: filters.state === null ? undefined : [filters.state],
    offset: filters.offset > 0 ? filters.offset : undefined,
    limit: filters.limit,
    order: filters.order === "desc" ? "desc" : undefined,
    sort,
    name: filters.names.length > 0 ? filters.names : undefined,
    search: filters.search || undefined,
    total: filters.total ? true : undefined,
    workerKey:
      attribution && attribution.workerKeys.length > 0
        ? attribution.workerKeys
        : undefined,
    workerId:
      attribution && attribution.workerIds.length > 0
        ? attribution.workerIds
        : undefined,
    finishedFrom:
      finished === null
        ? undefined
        : finished.kind === "last"
          ? now - finished.ms
          : finished.from,
    finishedTo:
      finished !== null && finished.kind === "between"
        ? finished.to
        : undefined,
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

/**
 * `GET /queues/:queue`. A body without a string `name`, a boolean `paused`
 * and a number `total` rejects with an `UNEXPECTED_RESPONSE` `ApiError`, so
 * the screen shows its error state rather than a queue with nothing in it.
 */
export async function getQueue(
  api: ApiClient,
  queue: string,
  signal?: AbortSignal,
): Promise<QueueDetailDto> {
  const path = base(queue);
  const body = await api.request<unknown>("GET", path, { signal });
  return assertShape<QueueDetailDto>(
    body,
    (fields) =>
      hasStrings(fields, "name") &&
      typeof fields.paused === "boolean" &&
      typeof fields.total === "number",
    "a queue",
    path,
  );
}

/** `GET /queues/:queue/counts`. */
export function getQueueCounts(
  api: ApiClient,
  queue: string,
  signal?: AbortSignal,
): Promise<JobCountsDto> {
  return api.request<JobCountsDto>("GET", base(queue, "/counts"), { signal });
}

/**
 * `GET /queues/:queue/jobs`. The attribution filters go out only with
 * `options.attribution` (`features.jobAttribution`) true, and
 * `sort=createdAt` only with `options.createdOrder`
 * (`features.addedByState`) true.
 */
export function listJobs(
  api: ApiClient,
  queue: string,
  filters: JobListFilters,
  signal?: AbortSignal,
  options: JobListQueryOptions = {},
): Promise<JobPageDto> {
  return api.request<JobPageDto>("GET", base(queue, "/jobs"), {
    query: jobListQuery(filters, options),
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
