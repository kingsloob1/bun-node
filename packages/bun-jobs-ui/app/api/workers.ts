import type { ApiClient, QueryValue } from "./client";
import type {
  WorkerConfigBody,
  WorkerConfigResultDto,
  WorkerControlBody,
  WorkerControlResultDto,
  WorkerDesiredState,
  WorkerDto,
  WorkerListDto,
  WorkerListQuery,
  WorkerState,
} from "./types";
import { segment } from "./client";

/**
 * The Workers screens' reads and query keys. Every worker read sits under
 * {@link workerKeys.all} (`["workers"]`), so one invalidation after a worker
 * action refreshes the Workers page and each queue's Workers panel alike.
 */
export const workerKeys = {
  /** Every worker read. */
  all: ["workers"] as const,
  /**
   * `GET /workers`, under the filters it was sent with: the unfiltered list
   * is `list()` (an empty query), so a screen reading it for its filter
   * choices shares one cache entry with a screen showing it.
   */
  list: (query: WorkerListQuery = {}) =>
    ["workers", "list", listQuery(query)] as const,
  /** `GET /workers?queue=<queue>&key=<key>&includeOffline=true`: one stable key's instances, as the worker page reads them. */
  ofKey: (queue: string, key: string) =>
    ["workers", "key", queue, key] as const,
  /** `GET /queues/:queue/workers`, as the queue panel reads it. */
  ofQueue: (queue: string) => ["queue", queue, "workers"] as const,
};

/** What a worker write invalidates: every worker read, on the Workers page and in each queue panel. */
export function workerInvalidations(queue: string) {
  return [workerKeys.all, workerKeys.ofQueue(queue)];
}

/**
 * A {@link WorkerListQuery} as it is sent and keyed: an empty filter left out
 * rather than sent as `key=` (which the API reads as "match nothing"), and
 * `includeOffline` only when it is asked for.
 */
function listQuery(query: WorkerListQuery): Record<string, QueryValue> {
  const out: Record<string, QueryValue> = {};
  const names = ["queue", "service", "host", "state", "key"] as const;
  for (const name of names) {
    const values = query[name];
    if (values && values.length > 0) {
      out[name] = [...values];
    }
  }
  if (query.includeOffline === true) {
    out.includeOffline = true;
  }
  return out;
}

/**
 * `GET /workers`: every live worker on the queues the caller may read,
 * narrowed by `query` — every filter exact and repeatable, and the filters
 * ANDed. A `host` filter is answered 400 `INVALID_ARGUMENT` when the API hides
 * hosts (`serialize.exposeHosts: false`), so a caller sends one only when the
 * workers it was shown carry a `host`.
 */
export function listWorkers(
  api: ApiClient,
  query: WorkerListQuery = {},
  signal?: AbortSignal,
): Promise<WorkerListDto> {
  return api.request<WorkerListDto>("GET", "/workers", {
    query: listQuery(query),
    signal,
  });
}

/** The app path of one stable worker key's page: its queue, then the key (a key is unique only within its queue). */
export function workerPath(queue: string, key: string): string {
  return `/workers/${segment(queue)}/${segment(key)}`;
}

/** Whether the API exposes worker hosts, read from workers it returned: `undefined` when there is none to tell by. */
export function hostsExposed(items: readonly WorkerDto[]): boolean | undefined {
  if (items.length === 0) {
    return undefined;
  }
  return items.some((worker) => worker.host !== undefined);
}

/** The distinct values of one field across `items`, sorted, absent values left out. */
export function distinctValues(
  items: readonly WorkerDto[],
  field: "queue" | "service" | "host",
): string[] {
  const values = new Set<string>();
  for (const worker of items) {
    const value = worker[field];
    if (value !== undefined) {
      values.add(value);
    }
  }
  return [...values].sort(byText);
}

/** One server's workers: a host and pid, or `null` for both when the API hides hosts. */
export interface WorkerServer {
  /** Stable key: `host:pid`, or `"hidden"`. */
  key: string;
  /** Its host, when exposed. */
  host: string | null;
  /** Its pid, when exposed. */
  pid: number | null;
  /** Its workers, by queue then id. */
  workers: WorkerDto[];
}

/** One service's servers, as the Workers page groups them. */
export interface WorkerServiceGroup {
  /** The service a process named itself (`BunJobs`'s `service` option), or `null` when it named none. */
  service: string | null;
  /** Its servers, by host then pid. */
  servers: WorkerServer[];
  /** How many workers it has, across its servers. */
  count: number;
}

/** Compares two strings, the way the groupings order their names. */
function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Groups workers by the server hosting them (host and pid), servers ordered
 * by host then pid, workers by queue then id. With `exposeHosts: false` every
 * worker lands in one group whose host and pid are `null`.
 */
export function groupByServer(items: readonly WorkerDto[]): WorkerServer[] {
  const servers = new Map<string, WorkerServer>();
  for (const worker of items) {
    const hidden = worker.host === undefined && worker.pid === undefined;
    const key = hidden
      ? "hidden"
      : `${worker.host ?? "?"}:${worker.pid ?? "?"}`;
    let server = servers.get(key);
    if (!server) {
      server = {
        key,
        host: worker.host ?? null,
        pid: worker.pid ?? null,
        workers: [],
      };
      servers.set(key, server);
    }
    server.workers.push(worker);
  }
  const out = [...servers.values()];
  for (const server of out) {
    server.workers.sort(
      (a, b) => byText(a.queue, b.queue) || byText(a.id, b.id),
    );
  }
  return out.sort(
    (a, b) => byText(a.host ?? "", b.host ?? "") || (a.pid ?? 0) - (b.pid ?? 0),
  );
}

/**
 * Groups workers by the service that runs them, then by server: what the
 * Workers page shows. Services are ordered by name, with the workers of
 * processes that named no service (`service` absent) last, in a group whose
 * `service` is `null`.
 */
export function groupByService(
  items: readonly WorkerDto[],
): WorkerServiceGroup[] {
  const services = new Map<string, WorkerDto[]>();
  for (const worker of items) {
    const name = worker.service ?? "";
    const group = services.get(name);
    if (group) {
      group.push(worker);
    } else {
      services.set(name, [worker]);
    }
  }
  return [...services.entries()]
    .map(([name, workers]) => ({
      service: name === "" ? null : name,
      servers: groupByServer(workers),
      count: workers.length,
    }))
    .sort((a, b) =>
      a.service === null
        ? 1
        : b.service === null
          ? -1
          : byText(a.service, b.service),
    );
}

/** Whether a worker's id, key, service, queue, host or pid contains every whitespace-separated word of `filter`, ignoring case. */
export function matchesWorker(worker: WorkerDto, filter: string): boolean {
  const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const text =
    `${worker.id} ${worker.key ?? ""} ${worker.service ?? ""} ${worker.queue} ${worker.host ?? ""} ${worker.pid ?? ""}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

/** The API path of one worker: its queue, then its per-incarnation id. */
function workerBase(queue: string, id: string, suffix = ""): string {
  return `/queues/${segment(queue)}/workers/${segment(id)}${suffix}`;
}

/** The API path of one worker config override: its queue, then the stable key it applies to. */
function configBase(queue: string, key: string): string {
  return `/queues/${segment(queue)}/worker-configs/${segment(key)}`;
}

/**
 * How long a control call waits for the worker to acknowledge, in ms, sent as
 * `?wait=`. Long enough that a driver which delivers instructions promptly
 * (memory, Redis) answers `applied: true`, so the UI can say "Paused" rather
 * than "asked to pause"; short enough not to hold the button on a driver
 * where the worker only notices at its next poll.
 */
export const WORKER_CONTROL_WAIT_MS = 2_000;

/**
 * `POST /queues/:queue/workers/:worker/{pause,resume,stop,start}`: records the
 * instruction for one running worker (by its per-incarnation `id`). 202 means
 * stored, 200 acknowledged; both resolve, and `applied` says which happened.
 *
 * `wait` is a **query** parameter; `timeout` and `persist` travel in the body.
 */
export function controlWorker(
  api: ApiClient,
  queue: string,
  id: string,
  action: "pause" | "resume" | "stop" | "start",
  body: Omit<WorkerControlBody, "wait"> = {},
  wait: number = WORKER_CONTROL_WAIT_MS,
): Promise<WorkerControlResultDto> {
  const hasBody = body.timeout !== undefined || body.persist !== undefined;
  return api.request<WorkerControlResultDto>(
    "POST",
    workerBase(queue, id, `/${action}`),
    { query: { wait }, body: hasBody ? body : undefined },
  );
}

/**
 * `PUT /queues/:queue/worker-configs/:key`: a merge patch of the override,
 * keyed by the **stable key**, so it reaches every replica carrying it and
 * every one started later. A `null` value clears that setting's override.
 */
export function configureWorkers(
  api: ApiClient,
  queue: string,
  key: string,
  body: WorkerConfigBody,
): Promise<WorkerConfigResultDto> {
  return api.request<WorkerConfigResultDto>("PUT", configBase(queue, key), {
    body,
  });
}

/** `DELETE /queues/:queue/worker-configs/:key`: drops the whole override, back to what the code asked for. */
export function resetWorkerConfig(
  api: ApiClient,
  queue: string,
  key: string,
): Promise<WorkerConfigResultDto> {
  return api.request<WorkerConfigResultDto>("DELETE", configBase(queue, key));
}

/**
 * A worker's state, for an API that does not send one yet: `state` when it is
 * there, otherwise `paused` decides between `paused` and `running`.
 */
export function workerState(worker: WorkerDto): WorkerState {
  return worker.state ?? (worker.paused ? "paused" : "running");
}

/** Which lifecycle action a worker in this state can be asked for, and what it would do. */
export const WORKER_ACTION_FOR: Readonly<
  Record<WorkerState, readonly WorkerDesiredState[]>
> = {
  running: ["paused", "stopped"],
  paused: ["running", "stopped"],
  stopping: [],
  stopped: ["running"],
  restarting: [],
};

/** Whether the API can control this worker at all: it says so through `control.enabled`; an older worker sends no `control`. */
export function isControllable(worker: WorkerDto): boolean {
  return worker.control?.enabled === true;
}

/** Whether a worker's record has lapsed (it stopped reporting): `stale`, or an `expiresAt` in the past. */
export function isStale(worker: WorkerDto, now = Date.now()): boolean {
  return worker.stale ?? worker.expiresAt <= now;
}
