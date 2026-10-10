import type { ApiClient } from "./client";
import type {
  SummonCheckDto,
  SummonGroupListDto,
  SummonListDto,
  SummonResetBody,
  SummonStatusDto,
} from "./types";
import { ApiError } from "./errors";
import { queryKeys } from "./queryKeys";
import { assertShape, isRecord } from "./shape";

/**
 * Summoning: `GET /queues/:queue/summon` (a queue's status), the two opt-in
 * writes, "summon now" and reset (`queues.summon`), and `GET /summon`, every
 * controller in the API's process.
 *
 * `/meta` has no flag for one queue's summoning: the status answers only
 * where a summon controller for the queue runs in the API's process, and 409
 * `SUMMON_NOT_CONFIGURED` everywhere else. So the status read itself is what
 * decides whether a queue has anything to show, and a queue without a
 * summoner reads as `null` rather than as a failure.
 *
 * `features.summonList` says `GET /summon` is served: on wherever the summon
 * routes are (jobs mode), off in runner mode and absent on an older API. Its
 * action is `queues.list`; each controller is then listed only where the
 * caller may read its queue (`queues.read`), so a caller without that sees
 * `{ controllers: [] }`.
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
  /** `GET /summon`. */
  list: ["summon"] as const,
  /** `GET /summon/groups`. */
  groups: ["summon", "groups"] as const,
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
 * `GET /summon`: every summoning queue the API can reach, by queue — with a
 * controller in the API's process (`local: true`) or read from storage
 * (`local: false`) — with its readiness (local only), last outcome and
 * budget usage (absent for summon state a newer bun-jobs wrote). An empty
 * list, never a 409, where none summons.
 */
export async function listSummonControllers(
  api: ApiClient,
  signal?: AbortSignal,
): Promise<SummonListDto> {
  const path = "/summon";
  const body = await api.request<unknown>("GET", path, { signal });
  return assertShape<SummonListDto>(
    body,
    (fields) =>
      Array.isArray(fields.controllers) &&
      fields.controllers.every(
        (item: unknown) =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as { queue?: unknown }).queue === "string" &&
          // Absent for summon state a newer bun-jobs wrote; an object otherwise.
          ((item as { budget?: unknown }).budget === undefined ||
            (typeof (item as { budget?: unknown }).budget === "object" &&
              (item as { budget?: unknown }).budget !== null)),
      ),
    "the summon controllers",
    path,
  );
}

/** Whether `value` has the parts of a summon group every answer carries. */
function isGroup(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    isRecord(value.budget) &&
    isRecord(value.queues)
  );
}

/**
 * `GET /summon/groups` (action `queues.list`): every summon group with shared
 * state in the namespace, read from storage, each redacted to the member
 * queues the caller may read (`queues.read`) — so a group's `queues` is never
 * its whole membership. Served where `features.summonRemoteStatus` is on.
 */
export async function listSummonGroups(
  api: ApiClient,
  signal?: AbortSignal,
): Promise<SummonGroupListDto> {
  const path = "/summon/groups";
  const body = await api.request<unknown>("GET", path, { signal });
  return assertShape<SummonGroupListDto>(
    body,
    (fields) => Array.isArray(fields.groups) && fields.groups.every(isGroup),
    "the summon groups",
    path,
  );
}

/**
 * `POST /queues/:queue/summon/reset`: clears the failures, the backoff and
 * the open circuit — and, with `budget: true`, the budget usage this UTC
 * hour and day — and answers the status after it.
 *
 * Without `budget` it sends no body, as before the body existed, so an API
 * that predates it (`features.summonResetBudget` false) is asked nothing it
 * would refuse.
 */
export async function resetSummon(
  api: ApiClient,
  queue: string,
  options: SummonResetBody = {},
): Promise<SummonStatusDto> {
  const path = summonPath(queue, "/reset");
  const body = await api.request<unknown>(
    "POST",
    path,
    options.budget === true ? { body: { budget: true } } : undefined,
  );
  return assertShape<SummonStatusDto>(
    body,
    isStatus,
    "a queue's summon status",
    path,
  );
}
