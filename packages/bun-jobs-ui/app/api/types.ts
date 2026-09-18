import type { JobsApiAction, JobState } from "./contract";

/**
 * Response shapes of the bun-jobs management API, written out for the browser.
 *
 * Why not `import type { MetaDto } from "@kingsleyweb/bun-jobs"`: the package
 * ships raw `.ts`, so a type import makes this project compile the package's
 * whole source graph (bun-common, the drivers) — and under the DOM lib that
 * graph has genuine conflicts (`ReadableStream`, `CompressionFormat`,
 * `Worker.unref`), which fail the typecheck. So every shape is mirrored here,
 * citing what it mirrors, and `__tests__/app/type-drift/` asserts each is
 * identical* to the package's type (compiled without the DOM lib by
 * `__tests__/app/type-drift.test.ts`), so drift fails CI.
 *
 * Paths are relative to `packages/bun-jobs/lib/`.
 */

export type { JobsApiAction, JobState };

/** Which half of the package the API exposes. Mirrors `JobsApiMode` — api/config.ts:46. */
export type JobsApiMode = "jobs" | "runner" | "both";

/** How events reach the API's process. Mirrors `DriverCapabilities["events"]` — drivers/driver.ts:35. */
export type EventsMode = "push" | "poll" | "local";

/** What a backend supports. Mirrors `DriverCapabilities` — drivers/driver.ts:28-40. */
export interface DriverCapabilities {
  /** Whether a worker can block waiting for a job instead of polling. */
  blockingWait: boolean;
  /** How events reach other processes. */
  events: EventsMode;
  /** Whether several processes on one host can share the backend. */
  multiProcess: boolean;
  /** Whether several hosts can share it. */
  multiHost: boolean;
}

/** `GET /meta`. Mirrors `MetaDto` — api/serialize.ts:289-346. */
export interface MetaDto {
  /** The namespace managed. */
  namespace: string;
  /** The effective mode. */
  mode: JobsApiMode;
  /** Whether mutations are disabled. */
  readOnly: boolean;
  /** The API protocol version. */
  protocol: 1;
  /** The backend: its name and capabilities, never connection details. */
  driver: {
    /** The driver's name, e.g. `"redis"`. */
    name: string;
    /** What the backend supports. */
    capabilities: DriverCapabilities;
  };
  /** Optional features the backend supports. */
  features: {
    /** Job logs. */
    logs: boolean;
    /** Job updates. */
    update: boolean;
    /** Queue limits. */
    limits: boolean;
    /** Flows. */
    flows: boolean;
    /** Indexed name/id search (`false` still allows a scan). */
    search: boolean;
    /** Worker listing. */
    workers: boolean;
    /** Throughput metrics. */
    throughput: boolean;
  };
  /** How events reach this process. */
  events: EventsMode;
  /** Whether producers publish events, or `null` when unknown (always `null` today). */
  publishing: boolean | null;
  /** The socket, or `null` when it is off. */
  websocket: {
    /** Full socket path. */
    path: string;
    /** Heartbeat interval in ms. */
    heartbeatMs: number;
    /** Most subscriptions per connection. */
    maxSubscriptions: number;
  } | null;
  /** Docs endpoints (full paths), or `null` when they are off. */
  docs: {
    /** OpenAPI JSON path. */
    openapi: string;
    /** AsyncAPI JSON path, when the socket is on. */
    asyncapi?: string;
    /** Swagger UI path, when the UI is on. */
    ui?: string;
    /** AsyncAPI viewer path, when the UI is on and the socket exists. */
    asyncapiUi?: string;
  } | null;
}

/** One validation issue. Mirrors `ProblemIssueDto` — api/serialize.ts:27-34. */
export interface ProblemIssueDto {
  /** Which part of the request failed. */
  target: "params" | "query" | "body" | "headers";
  /** Dotted path within the target, or `""` for the target itself. */
  path: string;
  /** Human-readable description. */
  message: string;
}

/** Every error body, RFC 9457. Mirrors `ProblemDto` — api/serialize.ts:37-54. */
export interface ProblemDto {
  /** `urn:bun-jobs:error:<CODE>`. */
  type: string;
  /** Short, stable title for the code. */
  title: string;
  /** HTTP status. */
  status: number;
  /** Machine code, e.g. `QUEUE_NOT_FOUND`. */
  code: string;
  /** Human detail for this occurrence. */
  detail?: string;
  /** The request path. */
  instance?: string;
  /** Validation issues (only for `VALIDATION`). */
  issues?: ProblemIssueDto[];
  /** Safe, whitelisted context. */
  context?: Record<string, unknown>;
}

/** Jobs per state. Mirrors `JobCountsSchema` — api/schemas/queues.ts:12-23. */
export type JobCounts = Record<JobState, number>;

/** A queue at a glance. Mirrors `QueueSummaryDto` — api/serialize.ts:173-182. */
export interface QueueSummaryDto {
  /** The queue's name. */
  name: string;
  /** Jobs per state. */
  counts: JobCounts;
  /** Jobs in every state. */
  total: number;
  /** Whether the queue is paused. */
  paused: boolean;
}

/** `GET /queues`. Mirrors `QueueListSchema` — api/schemas/queues.ts:188-191. */
export interface QueueList {
  /** Queues sorted by name, at most `limits.maxQueues`. */
  items: QueueSummaryDto[];
  /** Whether more queues exist than were listed. */
  truncated: boolean;
}

/** `GET /overview`. Mirrors `OverviewSchema` — api/schemas/queues.ts:95-121. */
export interface Overview {
  /** Queues summarised. */
  queues: number;
  /** How many of them are paused. */
  pausedQueues: number;
  /** Jobs per state across every summarised queue. */
  counts: JobCounts;
  /** Jobs in every state across every summarised queue. */
  total: number;
  /** Whether more queues exist than `limits.maxQueues` summarised. */
  truncated: boolean;
  /** Live workers; absent when the backend keeps no worker records. */
  workers?: number;
  /** Throughput totals for the window; absent without `getThroughput`. */
  throughput?: {
    /** Minutes the window covers. */
    minutes: number;
    /** Jobs completed in the window. */
    completed: number;
    /** Attempts failed in the window. */
    failed: number;
  };
}

/** One minute of throughput. Mirrors `ThroughputBucket` — drivers/driver.ts:621-632. */
export interface ThroughputBucket {
  /** The start of the minute, epoch ms. */
  at: number;
  /** Jobs completed in that minute. */
  completed: number;
  /** Attempts failed in that minute. */
  failed: number;
}

/** `GET /queues/:queue/throughput`. Mirrors `QueueThroughput` — queue/types.ts:635-651. */
export interface QueueThroughput {
  /** Bucket length in ms (`60000`). */
  interval: number;
  /** Start of the oldest bucket, epoch ms. */
  from: number;
  /** Start of the newest (still filling) bucket, epoch ms. */
  to: number;
  /** One bucket per minute, oldest first. */
  buckets: ThroughputBucket[];
  /** Jobs completed across every bucket. */
  completed: number;
  /** Attempts failed across every bucket. */
  failed: number;
}

/** A worker consuming a queue. Mirrors `WorkerDto` — api/serialize.ts:257-287. */
export interface WorkerDto {
  /** The worker's id. */
  id: string;
  /** The queue it consumes. */
  queue: string;
  /** How many jobs it runs at once. */
  concurrency: number;
  /** How many jobs it was running at its last report. */
  active: number;
  /** Whether it was locally paused at its last report. */
  paused: boolean;
  /** When it started consuming, epoch ms. */
  startedAt: number;
  /** When it last reported, epoch ms. */
  heartbeatAt: number;
  /** When the record lapses unless the worker reports again, epoch ms. */
  expiresAt: number;
  /** The host it runs on; omitted with `exposeHosts: false`. */
  host?: string;
  /** Its process id; omitted with `exposeHosts: false`. */
  pid?: number;
}

/** `GET /workers`. Mirrors `WorkerListSchema` — api/schemas/queues.ts:150. */
export interface WorkerList {
  /** Live workers, oldest first. */
  items: WorkerDto[];
}

/**
 * `GET /meta/permissions`. Mirrors `PermissionsSchema` — api/schemas/meta.ts:79-88,
 * narrowed: the schema says `Record<string, boolean>`; the keys are actions,
 * and an action whose routes are pruned is **absent**, not `false`
 * (api/routes/meta.ts:160-180).
 */
export interface Permissions {
  /** Whether the caller may perform each action relevant to this API. */
  actions: Partial<Record<JobsApiAction, boolean>>;
}

/** `POST /queues/:queue/pause` and `/resume`. Mirrors `PausedSchema` — api/schemas/queues.ts:206. */
export interface PausedResult {
  /** The queue's paused state after the call. */
  paused: boolean;
}
