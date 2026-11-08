import type { WorkerState } from "../../api/contract";
import type { WorkerListQuery } from "../../api/types";
import { WORKER_STATES } from "../../api/contract";

/**
 * The Workers page's server-side filters, as the URL carries them: one value
 * each, `queue`, `service`, `host` and `state`. `GET /workers` takes each as
 * an exact, repeatable filter and ANDs them; the page offers one value per
 * filter, which is what a picker over the live list can offer.
 */
export interface WorkerFilterValues {
  /** `?queue=`: only workers consuming this queue; `""` for any. */
  queue: string;
  /** `?service=`: only workers in this service; `""` for any. */
  service: string;
  /** `?host=`: only workers on this host; `""` for any. Sent only when the API exposes hosts. */
  host: string;
  /** `?state=`: only workers in this state; `""` for any. A value that is not a worker state is ignored. */
  state: WorkerState | "";
}

/** The URL parameters the filters live in, in the order the filter row shows them. */
export const WORKER_FILTER_PARAMS = [
  "queue",
  "service",
  "host",
  "state",
] as const satisfies readonly (keyof WorkerFilterValues)[];

/** Whether `value` is one of the contract's worker states. */
function isWorkerState(value: string): value is WorkerState {
  return (WORKER_STATES as readonly string[]).includes(value);
}

/** Reads the filters from the query string; a missing or unknown value means "any". */
export function readWorkerFilters(params: URLSearchParams): WorkerFilterValues {
  const state = params.get("state")?.trim() ?? "";
  return {
    queue: params.get("queue")?.trim() ?? "",
    service: params.get("service")?.trim() ?? "",
    host: params.get("host")?.trim() ?? "",
    state: isWorkerState(state) ? state : "",
  };
}

/** Whether any filter is set. */
export function hasWorkerFilters(filters: WorkerFilterValues): boolean {
  return WORKER_FILTER_PARAMS.some((name) => filters[name] !== "");
}

/**
 * The `GET /workers` query for these filters. `host` is left out unless
 * `hostsShown`: the API answers 400 `INVALID_ARGUMENT` to a host filter when
 * it hides hosts, and a link carrying `?host=` must not break the page.
 */
export function workerListQuery(
  filters: WorkerFilterValues,
  hostsShown: boolean,
): WorkerListQuery {
  const query: WorkerListQuery = {};
  if (filters.queue) {
    query.queue = [filters.queue];
  }
  if (filters.service) {
    query.service = [filters.service];
  }
  if (filters.host && hostsShown) {
    query.host = [filters.host];
  }
  if (filters.state) {
    query.state = [filters.state];
  }
  return query;
}
