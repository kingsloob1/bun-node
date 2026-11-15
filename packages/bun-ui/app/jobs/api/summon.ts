import type { ApiClient } from "./client";
import type { SummonResetBody } from "./types";
import { ApiError } from "./errors";
import { checkShape, isRecord } from "./shape";
import { dataOf, failedError, toApiError, typedApi } from "./typed";

/**
 * Summoning: `GET /queues/:queue/summon` (a queue's status), the two opt-in
 * writes, "summon now" and reset (`queues.summon`), and `GET /summon`, every
 * controller in the API's process.
 *
 * `/meta` has no flag for one queue's summoning: the status read itself is
 * what decides whether a queue has anything to show. It answers the status
 * where the queue has summoning (a controller in the API's process, or
 * summon state in storage), and `{ queue, configured: false }` everywhere
 * else; bun-jobs 3.2 and earlier answered that 409 `SUMMON_NOT_CONFIGURED`
 * instead. A queue without summoning reads as `null` either way, rather than
 * as a failure.
 *
 * `features.summonList` says `GET /summon` is served: on wherever the summon
 * routes are (jobs mode), off in runner mode and absent on an older API. Its
 * action is `queues.list`; each controller is then listed only where the
 * caller may read its queue (`queues.read`), so a caller without that sees
 * `{ controllers: [] }`.
 *
 * The domain the typed-client pilot moved onto `@kingsleyweb/bun-client`
 * (`./typed.ts`): every call is typed by the generated route map, params,
 * body and result alike, with no asserted type, and the keys are the query
 * layer's (`[routeKey, { params, query }]`). The few fields a screen cannot
 * draw without are still checked at run time ({@link checkShape}): the
 * client checks no response without schemas, and a host answering `{}` (a
 * misrouted proxy, a stub) should get the screen's error view, not a crash.
 */

/**
 * The code "summon now" and reset answer where no controller for the queue
 * runs in the API's process, and the code the status read answered for a
 * queue with no summoning on bun-jobs 3.2 and earlier.
 */
export const SUMMON_NOT_CONFIGURED = "SUMMON_NOT_CONFIGURED";

/**
 * Query keys of the summon reads: the query layer's (`q.key`), so they are
 * the keys `q.query()` would give the same calls, `[routeKey, { params,
 * query }]`.
 */
export const summonKeys = {
  /** `GET /queues/:queue/summon`. */
  status: (api: ApiClient, queue: string) =>
    typedApi(api).q.key("GET /queues/:queue/summon", { params: { queue } }),
  /** `GET /summon`. */
  list: (api: ApiClient) => typedApi(api).q.key("GET /summon", {}),
  /** `GET /summon/groups`. */
  groups: (api: ApiClient) => typedApi(api).q.key("GET /summon/groups", {}),
  /** What a summon or a reset changes: the queue's status, and every list and group read. */
  changed: (api: ApiClient, queue: string) => [
    summonKeys.status(api, queue),
    typedApi(api).q.key("GET /summon"),
    typedApi(api).q.key("GET /summon/groups"),
  ],
};

/** `/queues/:queue/summon…` under the API base, as an error's `instance`. */
function summonPath(queue: string, suffix = ""): string {
  return `/queues/${encodeURIComponent(queue)}/summon${suffix}`;
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

/** Whether a `GET /summon` row has the parts every answer carries; `budget` is absent for summon state a newer bun-jobs wrote, an object otherwise. */
function isListItem(item: unknown): boolean {
  return (
    isRecord(item) &&
    typeof item.queue === "string" &&
    (item.budget === undefined || isRecord(item.budget))
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
 * Whether `error` is the 409 `SUMMON_NOT_CONFIGURED` an API from bun-jobs
 * 3.2 or earlier answered the status read with for a queue with no
 * summoning. The route no longer declares it, so the typed client throws it
 * as an undeclared status, which {@link toApiError} turns into this.
 */
function isLegacyNotConfigured(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    error.code === SUMMON_NOT_CONFIGURED
  );
}

/**
 * `GET /queues/:queue/summon`: the queue's summon status, or `null` where the
 * queue has no summoning (`configured: false`, or the 409
 * `SUMMON_NOT_CONFIGURED` an older API answers for it) or the server has no
 * summon routes (404). Any other failure throws.
 */
export async function getSummonStatus(
  api: ApiClient,
  queue: string,
  signal?: AbortSignal,
) {
  const instance = summonPath(queue);
  let result;
  try {
    result = await typedApi(api).client.get("/queues/:queue/summon", {
      params: { queue },
      signal,
    });
  } catch (error) {
    const failure = await toApiError(error, instance);
    if (isLegacyNotConfigured(failure)) {
      return null;
    }
    throw failure;
  }
  if (result.ok) {
    // `=== false`: an older API sends no `configured` on a status.
    if (result.data.configured === false) {
      return null;
    }
    return checkShape(
      result.data,
      isStatus,
      "a queue's summon status",
      instance,
    );
  }
  if (result.status === 404) {
    return null;
  }
  throw failedError(result, instance);
}

/**
 * `POST /queues/:queue/summon`: "summon now". `force` skips the cooldown, and
 * nothing else: the circuit, the budget, the attempts already on their way
 * and the compare-and-set still hold.
 */
export async function summonNow(api: ApiClient, queue: string, force: boolean) {
  const path = summonPath(queue);
  const check = await dataOf(
    typedApi(api).client.post("/queues/:queue/summon", {
      params: { queue },
      body: { force },
    }),
    path,
  );
  return checkShape(
    check,
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
) {
  const path = "/summon";
  const list = await dataOf(typedApi(api).client.get(path, { signal }), path);
  return checkShape(
    list,
    (fields) =>
      Array.isArray(fields.controllers) && fields.controllers.every(isListItem),
    "the summon controllers",
    path,
  );
}

/**
 * `GET /summon/groups` (action `queues.list`): every summon group with shared
 * state in the namespace, read from storage, each redacted to the member
 * queues the caller may read (`queues.read`) — so a group's `queues` is never
 * its whole membership. Served where `features.summonStoredStatus` is on.
 */
export async function listSummonGroups(api: ApiClient, signal?: AbortSignal) {
  const path = "/summon/groups";
  const groups = await dataOf(typedApi(api).client.get(path, { signal }), path);
  return checkShape(
    groups,
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
) {
  const path = summonPath(queue, "/reset");
  const status = await dataOf(
    typedApi(api).client.post("/queues/:queue/summon/reset", {
      params: { queue },
      body: options.budget === true ? { budget: true } : undefined,
    }),
    path,
  );
  return checkShape(status, isStatus, "a queue's summon status", path);
}
