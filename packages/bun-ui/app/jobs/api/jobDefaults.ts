import type { ApiClient } from "./client";
import type { ShapeFields } from "./shape";
import type {
  ApplyJobDefaultsBody,
  ApplyJobDefaultsResultDto,
  JobDefaultsBody,
  JobDefaultsDto,
} from "./types";
import { segment } from "./client";
import { queryKeys } from "./queryKeys";
import { assertShape, hasStrings } from "./shape";

/**
 * A queue's job defaults: `GET`/`PUT`/`DELETE /queues/:queue/job-defaults`
 * and `POST /queues/:queue/job-defaults/apply`.
 *
 * The key sits under `queryKeys.queue(q)`, so every queue mutation's
 * invalidation (`mutationInvalidations`) re-reads the defaults too, and the
 * pending counts they carry.
 */

/**
 * Most jobs one apply call examines: the API's own default `limit`.
 *
 * The API's own ceiling is `meta.limits.maxApplyDefaults` (default 1000, a
 * host may raise it to 10 000), so a batch is the smaller of the two — see
 * {@link applyBatchLimit}. Over the ceiling the API answers 400 VALIDATION.
 */
export const APPLY_BATCH_LIMIT = 1_000;

/** One apply batch's size: {@link APPLY_BATCH_LIMIT}, capped by the API's `maxApplyDefaults`. */
export function applyBatchLimit(maxApplyDefaults: number): number {
  return Math.max(1, Math.min(APPLY_BATCH_LIMIT, maxApplyDefaults));
}

/** `GET /queues/:queue/job-defaults`'s query key. */
export function jobDefaultsKey(queue: string) {
  return [...queryKeys.queue(queue), "job-defaults"] as const;
}

/** The API path of a queue's job defaults, plus an optional suffix. */
function path(queue: string, suffix = ""): string {
  return `/queues/${segment(queue)}/job-defaults${suffix}`;
}

/** Whether a body is shaped like a {@link JobDefaultsDto}. */
function isJobDefaults(fields: ShapeFields): boolean {
  return (
    hasStrings(fields, "queue") &&
    typeof fields.seq === "number" &&
    Array.isArray(fields.overridden) &&
    typeof fields.effective === "object" &&
    fields.effective !== null &&
    typeof fields.code === "object" &&
    fields.code !== null &&
    typeof fields.pending === "object" &&
    fields.pending !== null
  );
}

/**
 * `GET /queues/:queue/job-defaults`. A body that is not job defaults rejects
 * with an `UNEXPECTED_RESPONSE` `ApiError`, so the panel shows an error rather
 * than a form with nothing in it.
 */
export async function getJobDefaults(
  api: ApiClient,
  queue: string,
  signal?: AbortSignal,
): Promise<JobDefaultsDto> {
  const url = path(queue);
  const body = await api.request<unknown>("GET", url, { signal });
  return assertShape<JobDefaultsDto>(body, isJobDefaults, "job defaults", url);
}

/** `PUT /queues/:queue/job-defaults`: a merge patch (`null` clears one key). Resolves the defaults after the write. */
export function setJobDefaults(
  api: ApiClient,
  queue: string,
  body: JobDefaultsBody,
) {
  return api.request<JobDefaultsDto>("PUT", path(queue), { body });
}

/**
 * `DELETE /queues/:queue/job-defaults?expectedSeq=`: every key back to the
 * code's value. `expectedSeq` is the `seq` read, so a reset racing someone
 * else's save answers 409 `CONTROL_CONTENDED` instead of silently erasing it.
 * Resolves the defaults after the write.
 */
export function resetJobDefaults(
  api: ApiClient,
  queue: string,
  expectedSeq: number,
) {
  return api.request<JobDefaultsDto>("DELETE", path(queue), {
    query: { expectedSeq },
  });
}

/** `POST /queues/:queue/job-defaults/apply`: one batch of the rewrite. */
export function applyJobDefaults(
  api: ApiClient,
  queue: string,
  body: ApplyJobDefaultsBody,
) {
  return api.request<ApplyJobDefaultsResultDto>("POST", path(queue, "/apply"), {
    body,
  });
}
