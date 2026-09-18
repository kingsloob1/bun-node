import type {
  DriverCapabilitiesDto,
  JobCountsDto,
  OverviewDto,
  PermissionsDto,
  QueueListDto,
  QueuePausedDto,
  QueueThroughputDto,
  ThroughputBucketDto,
  WorkerListDto,
} from "@kingsleyweb/bun-jobs/api/contract";
import type { JobsApiAction } from "./contract";

/**
 * Request and response shapes of the bun-jobs management API.
 *
 * They are the package's own types, from its browser-safe
 * `@kingsleyweb/bun-jobs/api/contract` entry, so they cannot drift from what
 * the server sends. The aliases below keep the names the app's screens were
 * written against; new code may use the contract's names (`…Dto` responses,
 * `…Body` request bodies, `…Query` queries) directly.
 */
export type * from "@kingsleyweb/bun-jobs/api/contract";

/** `GET /overview`. */
export type Overview = OverviewDto;
/** `GET /queues`. */
export type QueueList = QueueListDto;
/** `GET /queues/:queue/throughput`. */
export type QueueThroughput = QueueThroughputDto;
/** One minute of throughput. */
export type ThroughputBucket = ThroughputBucketDto;
/** `GET /workers`. */
export type WorkerList = WorkerListDto;
/** `POST /queues/:queue/pause` and `/resume`. */
export type PausedResult = QueuePausedDto;
/** Jobs per state. */
export type JobCounts = JobCountsDto;
/** What a backend supports. */
export type DriverCapabilities = DriverCapabilitiesDto;
/** How events reach the API's process. */
export type EventsMode = DriverCapabilitiesDto["events"];

/**
 * `GET /meta/permissions`, narrowed: the contract types `actions` as
 * `Record<string, boolean>`; its keys are actions, and an action whose routes
 * are pruned is **absent**, not `false` (api/routes/meta.ts).
 */
export type Permissions = Omit<PermissionsDto, "actions"> & {
  /** Whether the caller may perform each action relevant to this API. */
  actions: Partial<Record<JobsApiAction, boolean>>;
};
