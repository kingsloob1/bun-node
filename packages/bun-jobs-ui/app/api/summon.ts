import type { ApiClient } from "./client";
import type { SummonCheckDto, SummonStatusDto } from "./types";
import { ApiError } from "./errors";
import { queryKeys } from "./queryKeys";
import { assertShape } from "./shape";

/**
 * A queue's summoning: `GET /queues/:queue/summon` (the status), and the two
 * opt-in writes, "summon now" and reset (`queues.summon`).
 *
 * `/meta` has no flag for it: the status answers only where a summon
 * controller for the queue runs in the API's process, and 409
 * `SUMMON_NOT_CONFIGURED` everywhere else. So the status read itself is what
 * decides whether a queue has anything to show, and a queue without a
 * summoner reads as `null` rather than as a failure.
 */

/** The code the status answers where no controller for the queue runs in the API's process. */
export const SUMMON_NOT_CONFIGURED = "SUMMON_NOT_CONFIGURED";

/** `/queues/:queue/summon…`, relative to the API base. */
function summonPath(queue: string, suffix = ""): string {
  return `/queues/${encodeURIComponent(queue)}/summon${suffix}`;
}

/** Query keys of the summon reads. */
export const summonKeys = {
  /** `GET /queues/:queue/summon`. */
  status: (queue: string) => [...queryKeys.queue(queue), "summon"] as const,
};

/** Whether `error` says the queue has no summoner here, or the server has no summon routes. */
export function isNoSummoner(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    ((error.status === 409 && error.code === SUMMON_NOT_CONFIGURED) ||
      error.status === 404)
  );
}

/** Whether `fields` has the parts of a status every answer carries. */
function isStatus(fields: Record<string, unknown>): boolean {
  return (
    typeof fields.queue === "string" &&
    typeof fields.local === "boolean" &&
    typeof fields.inert === "boolean" &&
    Array.isArray(fields.pending) &&
    typeof fields.failures === "number"
  );
}

/**
 * `GET /queues/:queue/summon`: the queue's summon status, or `null` where the
 * queue has no summoner in the API's process (409 `SUMMON_NOT_CONFIGURED`)
 * or the server has no summon routes (404). Any other failure throws.
 */
export async function getSummonStatus(
  api: ApiClient,
  queue: string,
  signal?: AbortSignal,
): Promise<SummonStatusDto | null> {
  const path = summonPath(queue);
  try {
    const body = await api.request<unknown>("GET", path, { signal });
    return assertShape<SummonStatusDto>(
      body,
      isStatus,
      "a queue's summon status",
      path,
    );
  } catch (error) {
    if (isNoSummoner(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * `POST /queues/:queue/summon`: "summon now". `force` skips the cooldown, and
 * nothing else: the circuit, the budget, the attempts already on their way
 * and the compare-and-set still hold.
 */
export async function summonNow(
  api: ApiClient,
  queue: string,
  force: boolean,
): Promise<SummonCheckDto> {
  const path = summonPath(queue);
  const body = await api.request<unknown>("POST", path, { body: { force } });
  return assertShape<SummonCheckDto>(
    body,
    (fields) => typeof fields.action === "string",
    "a summon check",
    path,
  );
}

/**
 * `POST /queues/:queue/summon/reset`: clears the failures, the backoff and
 * the open circuit, and answers the status after it.
 */
export async function resetSummon(
  api: ApiClient,
  queue: string,
): Promise<SummonStatusDto> {
  const path = summonPath(queue, "/reset");
  // The route takes no body.
  const body = await api.request<unknown>("POST", path);
  return assertShape<SummonStatusDto>(
    body,
    isStatus,
    "a queue's summon status",
    path,
  );
}
