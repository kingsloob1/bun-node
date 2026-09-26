import type { ApiClient } from "./client";
import type { QueueDemandDto, QueueDemandListDto } from "./types";
import { queryKeys } from "./queryKeys";
import { assertShape } from "./shape";

/**
 * A queue's demand: what a scaler polls to decide how many workers to run
 * (`GET /queues/:queue/demand`, and `GET /demand` for several queues).
 *
 * Both routes are served wherever `features.demand` is true — every backend
 * except `runner` mode — but not every backend can count directly: an answer
 * says so itself (`exact: false`), and `/meta` has no signal for it, so the
 * UI reads it from each answer rather than assuming.
 */

/** The path segment of a queue name. */
function segment(value: string): string {
  return encodeURIComponent(value);
}

/** `GET /queues/:queue/demand`, relative to the API base. */
export function demandPath(queue: string): string {
  return `/queues/${segment(queue)}/demand`;
}

/** Query keys of the demand reads. */
export const demandKeys = {
  /** `GET /queues/:queue/demand`. */
  queue: (queue: string) => [...queryKeys.queue(queue), "demand"] as const,
  /** `GET /demand?queues=…` for these queues, in this order. */
  list: (queues: readonly string[]) => ["demand", "list", queues] as const,
};

/** Whether `value` has the numeric fields every demand answer carries. */
function isDemand(fields: Record<string, unknown>): boolean {
  return (
    typeof fields.queue === "string" &&
    typeof fields.paused === "boolean" &&
    typeof fields.exact === "boolean" &&
    typeof fields.capped === "boolean" &&
    [
      "at",
      "waiting",
      "dueNow",
      "stalled",
      "active",
      "workers",
      "demand",
      "outstanding",
    ].every((key) => typeof fields[key] === "number")
  );
}

/** `GET /queues/:queue/demand` (JSON). */
export async function getQueueDemand(
  api: ApiClient,
  queue: string,
  signal?: AbortSignal,
): Promise<QueueDemandDto> {
  const path = demandPath(queue);
  const body = await api.request<unknown>("GET", path, {
    signal,
    query: { format: "json" },
  });
  return assertShape<QueueDemandDto>(body, isDemand, "a queue's demand", path);
}

/**
 * `GET /demand` for `queues`, sent as repeated `queues` keys, so a name with
 * a comma in it is not split. A queue the caller cannot see is left out of
 * the answer, never an error.
 */
export async function listQueueDemand(
  api: ApiClient,
  queues: readonly string[],
  signal?: AbortSignal,
): Promise<QueueDemandListDto> {
  const path = "/demand";
  const body = await api.request<unknown>("GET", path, {
    signal,
    query: { format: "json", queues },
  });
  return assertShape<QueueDemandListDto>(
    body,
    (fields) =>
      Array.isArray(fields.queues) &&
      typeof fields.truncated === "boolean" &&
      fields.queues.every(
        (item: unknown) =>
          typeof item === "object" &&
          item !== null &&
          isDemand(item as Record<string, unknown>),
      ),
    "the queues' demand",
    path,
  );
}

/**
 * The absolute URLs a scaler reads a queue's demand from: JSON (a KEDA
 * `metrics-api` scaler, an ACA event job) and the Prometheus exposition.
 * Built on the page's origin when the API base is a path.
 */
export function demandUrls(
  apiBase: string,
  queue: string,
  origin: string,
): { json: string; prometheus: string } {
  const url = new URL(
    `${apiBase.replace(/\/$/, "")}${demandPath(queue)}`,
    origin,
  );
  const prometheus = new URL(url);
  prometheus.searchParams.set("format", "prometheus");
  return { json: url.href, prometheus: prometheus.href };
}
