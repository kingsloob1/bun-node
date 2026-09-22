import type { BunRequest } from "@kingsleyweb/bun-common";
import type { WorkerInfo } from "../../drivers/index";
import type { RemoteWorker } from "../../queue/RemoteWorker";
import type { WorkerConfigOverride } from "../../queue/workerControl";
import type {
  WorkerConfigKey,
  WorkerDesiredState,
  WorkerState,
} from "../../shared/workers";
import type { ResolvedJobsApiConfig } from "../config";
import type {
  WorkerConfigOverrideDto,
  WorkerConfigResultDto,
  WorkerControlResultDto,
} from "../contract/types";
import type { Infer } from "../schema/builder";
import type { AnyRouteDef, RouteServices } from "./define";
import { sleep } from "@kingsleyweb/bun-common";
import { supportsWorkers } from "../../drivers/index";
import { RemoteWorker as RemoteWorkerController } from "../../queue/RemoteWorker";
import {
  listWorkerConfigs,
  readWorkerControl,
  supportsWorkerControl,
} from "../../queue/workerControl";
import {
  WORKER_CONFIG_KEYS,
  workerConfigCrossFieldIssue,
} from "../../shared/workers";
import { ApiError } from "../errors";
import {
  queueWorkerListQuerySchema,
  WorkerConfigBodySchema,
  WorkerConfigListSchema,
  WorkerConfigResultSchema,
  WorkerControlBodySchema,
  workerControlQuerySchema,
  WorkerControlResultSchema,
  workerListQuerySchema,
  WorkerListSchema,
  WorkerSchema,
} from "../schemas/workers";
import { toWorkerDto } from "../serialize";
import { defineRoute } from "./define";
import { visibleQueueNames } from "./queues";
import {
  mapBounded,
  QueueParams,
  queueTarget,
  WorkerConfigParams,
  workerKeyTarget,
  WorkerParams,
  workerTarget,
} from "./support";

/**
 * The worker routes: who is consuming a queue, and what may be changed about
 * them from outside their process.
 *
 * Everything here is **queue-scoped**, control included, because the queue has
 * to be known before `authorize` runs (a route's `target` reads path and
 * validated params only). Resolving a bare worker id would mean a
 * namespace-wide scan before authorization — a read per queue, and an
 * existence oracle for a caller who may see none of them.
 *
 * Two addresses, because a worker has two identities: lifecycle
 * (`pause`/`resume`/`stop`/`start`) is addressed by the **incarnation** id, so
 * an instruction can never be applied by the process that replaced it;
 * configuration is addressed by the **stable key**, so it survives restarts
 * and reaches every replica.
 */

/** How often `?wait=` re-reads the worker records looking for the ack. */
export const WORKER_ACK_POLL_MS = 100;

/** Errors every route naming a queue can answer with. */
const QUEUE_ERRORS = ["INVALID_NAME", "QUEUE_NOT_FOUND"] as const;

/** Errors every route naming one worker can answer with. */
const WORKER_ERRORS = [
  ...QUEUE_ERRORS,
  "WORKER_NOT_FOUND",
  "WORKER_GONE",
] as const;

/** Errors every lifecycle route can answer with. */
const CONTROL_ERRORS = [
  ...WORKER_ERRORS,
  "WORKER_STATE_CONFLICT",
  "WORKER_NOT_CONTROLLABLE",
  "WORKER_PERSISTENCE_NOT_ALLOWED",
  "INVALID_ARGUMENT",
] as const;

/** How soon a control change reaches a worker, for the route descriptions. */
const CONTROL_LATENCY_NOTE =
  "The instruction is stored and announced, and the worker applies it when it hears: within milliseconds on a driver that pushes events, within its `remoteControl.interval` (2s by default) on one that does not, and within one `reportInterval` (10s) even if the announcement is lost. `?wait=` (ms) polls the worker's record for the acknowledgement and answers 200 with the re-read worker once it lands, or 202 when the wait runs out; it is also accepted in the body, and the query wins when both are sent. `timeout` and `persist` are stop semantics and are body-only.";

/** Whether a driver can both list workers and store what they should be. */
export function supportsRemoteWorkerControl(
  config: Pick<ResolvedJobsApiConfig, "driver">,
): boolean {
  return supportsWorkers(config.driver) && supportsWorkerControl(config.driver);
}

/**
 * The controller for one queue's workers. The context's own is preferred, so
 * a worker in this process is nudged directly rather than waiting for its
 * poll; without a context the API builds one over the same driver.
 */
function workersOf(services: RouteServices, queue: string): RemoteWorker {
  const { config } = services;
  return config.jobs
    ? config.jobs.workers.remote(queue)
    : new RemoteWorkerController({
        namespace: config.namespace,
        queue,
        driver: config.driver,
        logger: config.logger,
      });
}

/** What a worker is doing, falling back to its `paused` flag on an older record. */
export function workerStateOf(worker: WorkerInfo): WorkerState {
  return worker.state ?? (worker.paused ? "paused" : "running");
}

/** The stable key a worker is addressed by, falling back to its id. */
function workerKeyOf(worker: WorkerInfo): string {
  return worker.key ?? worker.id;
}

/** The 404 for a worker no live record names. */
function workerNotFound(queue: string, worker: string): ApiError {
  return new ApiError(
    "WORKER_NOT_FOUND",
    404,
    `Worker "${worker}" is not consuming queue "${queue}"`,
    { context: { queue, worker } },
  );
}

/**
 * The live worker a request names, or the error saying why it is not there:
 * 410 `WORKER_GONE` when an instruction is still stored against it (its
 * process died, so nothing can be delivered), 404 otherwise.
 */
async function requireWorker(
  services: RouteServices,
  remote: RemoteWorker,
  queue: string,
  id: string,
): Promise<WorkerInfo> {
  const found = await remote.get(id);
  if (found) {
    return found;
  }
  const stored = supportsWorkerControl(services.config.driver)
    ? await readWorkerControl(services.config.driver, remote.ref, id)
    : null;
  if (stored) {
    throw new ApiError(
      "WORKER_GONE",
      410,
      `Worker "${id}" has stopped reporting; its instruction cannot be delivered`,
      { context: { queue, worker: id } },
    );
  }
  throw workerNotFound(queue, id);
}

/** Refuses a worker that cannot hear an instruction at all. */
function requireControllable(worker: WorkerInfo): void {
  if (!worker.control?.enabled) {
    throw new ApiError(
      "WORKER_NOT_CONTROLLABLE",
      409,
      worker.control
        ? `Worker "${worker.id}" was started without remote control`
        : `Worker "${worker.id}" predates remote control`,
      { context: { worker: worker.id } },
    );
  }
}

/** One lifecycle action, and the states it may and need not be asked from. */
interface ControlAction {
  /** The state the instruction records. */
  desired: WorkerDesiredState;
  /** States the action is refused from, with 409 `WORKER_STATE_CONFLICT`. */
  conflictsWith: readonly WorkerState[];
  /** States the worker is already in, answered 200 `applied: true`. */
  satisfiedBy: readonly WorkerState[];
  /** What to do instead, named in the conflict's message. */
  instead: string;
}

/**
 * What each lifecycle route asks for.
 *
 * `restarting` is nowhere in `conflictsWith`: it is a millisecond transient
 * while a config change is applied, not a state to refuse an operator from.
 * A `stop` is never a conflict — stopping an already stopping worker is the
 * same instruction again — and `start` is accepted from `paused` too, since
 * it clears the pause with the park.
 */
const CONTROL_ACTIONS = {
  pause: {
    desired: "paused",
    conflictsWith: ["stopped", "stopping"],
    satisfiedBy: ["paused"],
    instead: "start it first",
  },
  resume: {
    desired: "running",
    conflictsWith: ["stopped", "stopping"],
    satisfiedBy: ["running"],
    instead: "use start",
  },
  stop: {
    desired: "stopped",
    conflictsWith: [],
    satisfiedBy: ["stopped"],
    instead: "",
  },
  start: {
    desired: "running",
    conflictsWith: [],
    satisfiedBy: ["running"],
    instead: "",
  },
} as const satisfies Record<string, ControlAction>;

/** One lifecycle route's name. */
type ControlName = keyof typeof CONTROL_ACTIONS;

/** Waits for the worker to report `appliedSeq >= seq`, or gives up at `waitMs`. */
async function waitForAck(
  remote: RemoteWorker,
  id: string,
  seq: number,
  waitMs: number,
): Promise<WorkerInfo | undefined> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const worker = await remote.get(id);
    if (worker && (worker.control?.appliedSeq ?? 0) >= seq) {
      return worker;
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      return undefined;
    }
    await sleep(Math.min(WORKER_ACK_POLL_MS, left), { unref: true });
  }
}

/** One lifecycle route. */
function controlRoute(name: ControlName, summary: string): AnyRouteDef {
  const action = CONTROL_ACTIONS[name] as ControlAction;
  return defineRoute({
    method: "POST",
    path: `/queues/:queue/workers/:worker/${name}`,
    operationId: `${name}Worker`,
    action: `workers.${name}`,
    mode: "jobs",
    enabledWhen: supportsRemoteWorkerControl,
    summary,
    description:
      name === "stop"
        ? `Parks the worker: it stops claiming, drains the jobs it holds, and stays registered and heartbeating so \`start\` can reach it — unlike \`close()\` in code, which unregisters it for good. \`timeout\` abandons the jobs still running after that many ms; their locks then lapse and another worker recovers them as stalled, so the work is delayed and run again from the start. How long the stop lasts is the worker's own \`stopPersistence\`; \`persist\` asks for the other one and is 409 \`WORKER_PERSISTENCE_NOT_ALLOWED\` unless the worker reports \`control.stopPersistenceOverridable\`. ${CONTROL_LATENCY_NOTE}`
        : `${summary}. ${CONTROL_LATENCY_NOTE}`,
    tags: ["Workers"],
    params: WorkerParams,
    query: workerControlQuerySchema(),
    body: WorkerControlBodySchema,
    bodyOptional: true,
    responses: {
      200: WorkerControlResultSchema,
      202: WorkerControlResultSchema,
    },
    errors: CONTROL_ERRORS,
    target: ({ params }) => workerTarget(params.queue, params.worker),
    handler: async ({ params, query, body, services }) => {
      // `?wait=` is what a client sends; the body's `wait` is the contract's
      // original spelling and still honoured, with the query winning.
      const wait = query.wait ?? body.wait;
      await services.queues.get(params.queue);
      const remote = workersOf(services, params.queue);
      const worker = await requireWorker(
        services,
        remote,
        params.queue,
        params.worker,
      );
      requireControllable(worker);

      const control = worker.control!;
      if (name !== "stop") {
        for (const field of ["timeout", "persist"] as const) {
          if (body[field] !== undefined) {
            throw new ApiError(
              "INVALID_ARGUMENT",
              400,
              `"${field}" applies to stop only`,
              { context: { field } },
            );
          }
        }
      }
      const persisted =
        name === "stop" ? (body.persist ?? control.stopPersistence) : undefined;
      if (
        body.persist !== undefined &&
        body.persist !== control.stopPersistence &&
        !control.stopPersistenceOverridable
      ) {
        throw new ApiError(
          "WORKER_PERSISTENCE_NOT_ALLOWED",
          409,
          `Worker "${worker.id}" does not let a request change how long a stop lasts`,
          {
            context: {
              worker: worker.id,
              stopPersistence: control.stopPersistence,
            },
          },
        );
      }

      const state = workerStateOf(worker);
      if (action.conflictsWith.includes(state)) {
        throw new ApiError(
          "WORKER_STATE_CONFLICT",
          409,
          `Worker "${worker.id}" cannot be ${name}d while it is ${state}${
            action.instead ? `: ${action.instead}` : ""
          }`,
          { context: { worker: worker.id, state } },
        );
      }

      const result =
        name === "stop"
          ? await remote.stop(
              { id: worker.id },
              {
                ...(body.persist === undefined
                  ? {}
                  : { persist: body.persist }),
                ...(body.timeout === undefined
                  ? {}
                  : { timeout: body.timeout }),
              },
            )
          : await remote[name]({ id: worker.id });
      const instance = result.instances.at(0);
      if (!instance) {
        // The record lapsed between the read and the write: the instruction
        // was addressed to nobody.
        throw workerNotFound(params.queue, worker.id);
      }

      // Already there: the instruction is still recorded, so a later reader
      // sees what was asked for, but nothing has to be waited for.
      const already = action.satisfiedBy.includes(state);
      const acked =
        already || instance.applied
          ? worker
          : wait
            ? await waitForAck(remote, worker.id, instance.seq, wait)
            : undefined;

      const dto: WorkerControlResultDto = {
        desired: action.desired,
        seq: instance.seq,
        applied: already || acked !== undefined,
        ...(persisted === undefined ? {} : { persisted }),
        ...(acked === undefined
          ? {}
          : { worker: toWorkerDto(acked, services.config.serialize) }),
      };
      return { status: dto.applied ? 200 : 202, body: dto };
    },
  });
}

/** Which live workers carry a key, and whether each has applied `seq`. */
function instancesOf(
  workers: readonly WorkerInfo[],
  key: string,
  seq: number,
): WorkerConfigOverrideDto["instances"] {
  return workers
    .filter((worker) => workerKeyOf(worker) === key)
    .map((worker) => ({
      id: worker.id,
      applied: (worker.control?.configSeq ?? 0) >= seq,
    }));
}

/** One stored override, with the live workers it reaches. */
function toOverrideDto(
  override: WorkerConfigOverride,
  workers: readonly WorkerInfo[],
): WorkerConfigOverrideDto {
  return {
    queue: override.queue,
    key: override.key,
    values: { ...override.values },
    seq: override.seq,
    updatedAt: override.updatedAt,
    instances: instancesOf(workers, override.key, override.seq),
  };
}

/** The filters a worker listing applies, as the query schema produced them. */
type WorkerListQuery = Infer<ReturnType<typeof workerListQuerySchema>> & {
  /** Present only on the namespace-wide listing. */
  queue?: string[];
};

/**
 * The workers a listing shows: every filter exact, repeatable and ANDed.
 * `host` is refused before this, when hosts are hidden.
 */
function filterWorkers(
  workers: readonly WorkerInfo[],
  query: WorkerListQuery,
): WorkerInfo[] {
  const matches = (values: string[] | undefined, value: string | undefined) =>
    values === undefined || (value !== undefined && values.includes(value));
  return workers.filter(
    (worker) =>
      matches(query.queue, worker.queue) &&
      matches(query.service, worker.service) &&
      matches(query.host, worker.host) &&
      matches(query.key, workerKeyOf(worker)) &&
      (query.state === undefined ||
        query.state.includes(workerStateOf(worker))),
  );
}

/** Refuses a `host` filter the caller could not read the answer to. */
function checkHostFilter(
  services: RouteServices,
  query: WorkerListQuery,
): void {
  if (query.host !== undefined && !services.config.serialize.exposeHosts) {
    throw new ApiError(
      "INVALID_ARGUMENT",
      400,
      "This API does not expose worker hosts, so it cannot filter on one",
      { context: { filter: "host" } },
    );
  }
}

/**
 * The stored overrides on `queues` that no live worker carries, filtered the
 * same way as the list. Read only when `includeOffline` asks for them: it is
 * one listing per queue.
 */
async function offlineOverrides(
  services: RouteServices,
  queues: readonly string[],
  live: readonly WorkerInfo[],
  query: WorkerListQuery,
): Promise<WorkerConfigOverrideDto[]> {
  if (!supportsWorkerControl(services.config.driver)) {
    return [];
  }
  const carried = new Set(
    live.map((worker) => `${worker.queue}\0${workerKeyOf(worker)}`),
  );
  const perQueue = await mapBounded(
    [...queues],
    async (queue) =>
      await listWorkerConfigs(services.config.driver, {
        ns: services.config.namespace,
        queue,
      }),
  );
  return perQueue
    .flat()
    .filter(
      (override) =>
        !carried.has(`${override.queue}\0${override.key}`) &&
        (query.key === undefined || query.key.includes(override.key)),
    )
    .map((override) => toOverrideDto(override, []));
}

/** The queues a namespace-wide listing may read, in name order. */
async function readableQueues(
  services: RouteServices,
  req: BunRequest,
  wanted: readonly string[],
): Promise<string[]> {
  const reachable = await services.queues.names();
  return await visibleQueueNames(
    services,
    req,
    reachable.filter((queue) => wanted.length === 0 || wanted.includes(queue)),
  );
}

/** The worker routes: listing, reading, lifecycle control and configuration. */
export function workerRoutes(): AnyRouteDef[] {
  return [
    defineRoute({
      method: "GET",
      path: "/queues/:queue/workers",
      operationId: "listQueueWorkers",
      action: "workers.list",
      mode: "jobs",
      enabledWhen: (config) => supportsWorkers(config.driver),
      summary: "The workers consuming this queue, in any process",
      description:
        "Live workers only: one that stopped reporting lapses and is not listed. `host` and `pid` are omitted when `serialize.exposeHosts` is off. The filters are exact, repeatable (`?state=paused&state=stopped`) and ANDed; `includeOffline` adds the overrides stored for keys no live worker carries.",
      tags: ["Workers"],
      params: QueueParams,
      query: queueWorkerListQuerySchema(),
      responses: { 200: WorkerListSchema },
      errors: [...QUEUE_ERRORS, "INVALID_ARGUMENT"],
      target: ({ params }) => queueTarget(params.queue),
      handler: async ({ params, query, services }) => {
        checkHostFilter(services, query);
        const queue = await services.queues.get(params.queue);
        const live = await queue.listWorkers();
        const now = Date.now();
        return {
          body: {
            items: filterWorkers(live, query).map((worker) =>
              toWorkerDto(worker, services.config.serialize, now),
            ),
            ...(query.includeOffline
              ? {
                  offline: await offlineOverrides(
                    services,
                    [params.queue],
                    live,
                    query,
                  ),
                }
              : {}),
          },
        };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/workers",
      operationId: "listWorkers",
      action: "workers.list",
      mode: "jobs",
      needsJobsSource: true,
      enabledWhen: (config) => supportsWorkers(config.driver),
      summary: "Every worker in the namespace",
      description:
        'Across every queue this API may see, oldest first. A worker consuming a queue outside `queues` is not listed, nor, with `listQueues: "authorized"`, one consuming a queue `authorize` denies `queues.read` on (one call per queue a worker consumes). The filters are exact, repeatable (`?state=paused&state=stopped`) and ANDed; `host` is 400 `INVALID_ARGUMENT` when `serialize.exposeHosts` is off, since it would answer the question that option hides. `includeOffline` adds the overrides stored for keys no live worker carries, one listing per reachable queue.',
      tags: ["Workers"],
      query: workerListQuerySchema(),
      responses: { 200: WorkerListSchema },
      errors: ["INVALID_ARGUMENT"],
      handler: async ({ req, query, services }) => {
        checkHostFilter(services, query);
        const workers = await services.config.jobs!.listWorkers();
        // Only the queues a worker consumes are asked about, not every queue.
        const reachable = new Set(await services.queues.names());
        const consumed = [
          ...new Set(
            workers
              .map((worker) => worker.queue)
              .filter((queue) => reachable.has(queue)),
          ),
        ].sort();
        const allowed = new Set(
          await visibleQueueNames(services, req, consumed),
        );
        const live = workers.filter((worker) => allowed.has(worker.queue));
        const now = Date.now();
        return {
          body: {
            items: filterWorkers(live, query).map((worker) =>
              toWorkerDto(worker, services.config.serialize, now),
            ),
            ...(query.includeOffline
              ? {
                  offline: await offlineOverrides(
                    services,
                    await readableQueues(services, req, query.queue ?? []),
                    live,
                    query,
                  ),
                }
              : {}),
          },
        };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/queues/:queue/workers/:worker",
      operationId: "getWorker",
      action: "workers.read",
      mode: "jobs",
      enabledWhen: (config) => supportsWorkers(config.driver),
      summary: "One worker, by its incarnation id",
      description:
        "410 `WORKER_GONE` when the record has lapsed but an instruction is still stored against the worker — its process died, so nothing can be delivered to it; 404 when nothing names it at all.",
      tags: ["Workers"],
      params: WorkerParams,
      responses: { 200: WorkerSchema },
      errors: WORKER_ERRORS,
      target: ({ params }) => workerTarget(params.queue, params.worker),
      handler: async ({ params, services }) => {
        await services.queues.get(params.queue);
        const remote = workersOf(services, params.queue);
        const worker = await requireWorker(
          services,
          remote,
          params.queue,
          params.worker,
        );
        return { body: toWorkerDto(worker, services.config.serialize) };
      },
    }),
    controlRoute("pause", "Stop the worker claiming new jobs"),
    controlRoute("resume", "Let a paused worker claim again"),
    controlRoute("stop", "Park the worker: drain its jobs and stop claiming"),
    controlRoute("start", "Bring a parked worker back, clearing any pause"),
    defineRoute({
      method: "GET",
      path: "/queues/:queue/worker-configs",
      operationId: "listWorkerConfigs",
      action: "workers.read",
      mode: "jobs",
      enabledWhen: supportsRemoteWorkerControl,
      summary: "Every configuration override stored on the queue",
      description:
        "Keyed by the workers' **stable** keys, so an override outlives the worker that had it: one whose `instances` is empty is stored for a key no worker currently carries, and can be deleted from here.",
      tags: ["Workers"],
      params: QueueParams,
      responses: { 200: WorkerConfigListSchema },
      errors: QUEUE_ERRORS,
      target: ({ params }) => queueTarget(params.queue),
      handler: async ({ params, services }) => {
        await services.queues.get(params.queue);
        const remote = workersOf(services, params.queue);
        const [overrides, live] = await Promise.all([
          remote.listConfigs(),
          remote.list(),
        ]);
        return {
          body: {
            items: overrides.map((override) => toOverrideDto(override, live)),
          },
        };
      },
    }),
    defineRoute({
      method: "PUT",
      path: "/queues/:queue/worker-configs/:key",
      operationId: "configureWorker",
      action: "workers.configure",
      mode: "jobs",
      enabledWhen: supportsRemoteWorkerControl,
      summary: "Merge settings into one stable key's override",
      description:
        "A **merge patch**: a setting left out is untouched, and `null` clears it so the worker's own value applies again. Keyed by the stable key, so it reaches every replica carrying it — including one started tomorrow — and survives restarts. Each setting is bounded by `WORKER_CONFIG_BOUNDS`; `heartbeatInterval` must also be at most half the *effective* `lockDuration` of every live worker it reaches, which is 400 `VALIDATION` with the issue on the offending field. Send `expectedSeq` for a safe read-modify-write: 409 `CONTROL_CONTENDED` when somebody wrote first, and nothing is changed. There is no `wait` here: `instances[].applied` is a snapshot taken immediately after the write, so a worker that has not applied the new version *yet* reads `false` even where it is about to within milliseconds. Poll `GET /queues/{queue}/workers` and compare `control.configSeq` with the `seq` this returned to watch it land.",
      tags: ["Workers"],
      params: WorkerConfigParams,
      body: WorkerConfigBodySchema,
      responses: { 200: WorkerConfigResultSchema },
      errors: [...QUEUE_ERRORS, "CONTROL_CONTENDED"],
      target: ({ params }) => workerKeyTarget(params.queue, params.key),
      handler: async ({ params, body, services }) => {
        await services.queues.get(params.queue);
        const remote = workersOf(services, params.queue);
        const values: Partial<Record<WorkerConfigKey, number | null>> = {};
        for (const key of WORKER_CONFIG_KEYS) {
          const value = body[key];
          if (value !== undefined) {
            values[key] = value;
          }
        }
        const live = await remote.list();
        await checkCrossField(remote, params.key, values, live);
        const result = await remote.setConfig(params.key, values, {
          ...(body.expectedSeq === undefined
            ? {}
            : { expectedSeq: body.expectedSeq }),
        });
        return { body: await configResult(remote, result, live) };
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/queues/:queue/worker-configs/:key",
      operationId: "resetWorkerConfig",
      action: "workers.configure",
      mode: "jobs",
      enabledWhen: supportsRemoteWorkerControl,
      summary: "Drop one stable key's override entirely",
      description:
        "Its workers go back to what their own code asks for. The entry is emptied rather than deleted — a deleted entry's version would restart at 1, and a worker that had applied version 3 would believe it was up to date — so this answers 200 with the new version rather than 204. There is no `wait` here: `instances[].applied` is a snapshot taken immediately after the write, so a worker that has not applied the new version *yet* reads `false` even where it is about to within milliseconds. Poll `GET /queues/{queue}/workers` and compare `control.configSeq` with the `seq` this returned to watch it land.",
      tags: ["Workers"],
      params: WorkerConfigParams,
      responses: { 200: WorkerConfigResultSchema },
      errors: [...QUEUE_ERRORS, "CONTROL_CONTENDED"],
      target: ({ params }) => workerKeyTarget(params.queue, params.key),
      handler: async ({ params, services }) => {
        await services.queues.get(params.queue);
        const remote = workersOf(services, params.queue);
        const live = await remote.list();
        const result = await remote.resetConfig(params.key);
        return { body: await configResult(remote, result, live) };
      },
    }),
  ];
}

/**
 * Refuses an override that would break the one rule a shape cannot hold: a
 * lock renewed less often than twice per lease can lapse under a job that is
 * still running, and the stalled sweep then runs it a second time.
 *
 * Checked against the **merged effective** values of every live worker the key
 * reaches — the pair is only meaningful together, and an override of either
 * field alone is enough to break it. With no live worker to ask, the merged
 * override is checked on its own, so a pair stored for a worker that starts
 * tomorrow is still refused today.
 */
async function checkCrossField(
  remote: RemoteWorker,
  key: string,
  patch: Readonly<Partial<Record<WorkerConfigKey, number | null>>>,
  live: readonly WorkerInfo[],
): Promise<void> {
  const stored = await remote.getConfig(key);
  const merged: Partial<Record<WorkerConfigKey, number>> = {
    ...stored.values,
  };
  for (const [field, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[field as WorkerConfigKey];
    } else if (value !== undefined) {
      merged[field as WorkerConfigKey] = value;
    }
  }

  const carriers = live.filter((worker) => workerKeyOf(worker) === key);
  const candidates = carriers.map((worker) => ({
    ...worker.config?.code,
    ...merged,
  }));
  if (candidates.length === 0) {
    candidates.push({ ...merged });
  }

  for (const candidate of candidates) {
    const { heartbeatInterval, lockDuration } = candidate;
    if (heartbeatInterval === undefined || lockDuration === undefined) {
      continue;
    }
    const issue = workerConfigCrossFieldIssue({
      heartbeatInterval,
      lockDuration,
    });
    if (issue) {
      throw new ApiError("VALIDATION", 400, issue.message, {
        issues: [{ target: "body", path: issue.key, message: issue.message }],
      });
    }
  }
}

/** The answer both configuration routes give, refusing a write somebody else won. */
async function configResult(
  remote: RemoteWorker,
  result: {
    /** The key it was stored for. */ key: string;
    /** What is stored now. */ values: WorkerConfigOverride["values"];
    /** Its version. */ seq: number;
    /** Whether somebody else wrote first. */ contended: boolean;
  },
  before: readonly WorkerInfo[],
): Promise<WorkerConfigResultDto> {
  if (result.contended) {
    throw new ApiError(
      "CONTROL_CONTENDED",
      409,
      `The override for "${result.key}" changed while this write was being made`,
      { context: { key: result.key, seq: result.seq } },
    );
  }
  // Re-read, so `state` and `applied` describe the workers as they are after
  // the write rather than before it; the list read for the cross-field check
  // is the fallback when the re-read fails to reach the backend.
  const live = await remote.list().catch(() => before);
  return {
    queue: remote.queue,
    key: result.key,
    values: { ...result.values },
    seq: result.seq,
    instances: live
      .filter((worker) => workerKeyOf(worker) === result.key)
      .map((worker) => ({
        id: worker.id,
        applied: (worker.control?.configSeq ?? 0) >= result.seq,
        ...(worker.state === undefined ? {} : { state: worker.state }),
      })),
  };
}
