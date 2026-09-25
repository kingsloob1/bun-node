import type { JobsDriver, QueueRef, WorkerInfo } from "../drivers/index";
import type { Logger, LoggerLike } from "../shared/logger";
import type {
  WorkerConfigKey,
  WorkerControlAction,
  WorkerDesiredState,
  WorkerState,
  WorkerStopPersistence,
} from "../shared/workers";
import type { WorkerConfigOverride } from "./workerControl";
import { listWorkerRecords, supportsWorkers } from "../drivers/index";
import { JobsError, NotSupportedError } from "../shared/errors";
import { workerEvent } from "../shared/events";
import { newToken } from "../shared/ids";
import { assertNamespace, assertSegment } from "../shared/keys";
import { createJobsLogger } from "../shared/logger";
import {
  listWorkerConfigs,
  readWorkerConfig,
  supportsWorkerControl,
  writeWorkerConfig,
  writeWorkerControl,
} from "./workerControl";

/**
 * What a worker registered in this process must offer for a controller to
 * reach it without a round trip.
 *
 * Structural rather than `BunQueueWorker` itself, so the controller needs
 * neither the class's three type parameters nor an import of it: the only
 * thing it does with a local worker is tell it to look again.
 */
export interface LocalWorker {
  /** Its incarnation id. */
  readonly id: string;
  /** Re-reads its stored instructions now. */
  syncControl: () => Promise<void>;
}

/** Which workers an instruction is addressed to. */
export type WorkerSelector =
  | {
      /** One incarnation, by its id. */
      id: string;
    }
  | {
      /**
       * Every live worker carrying this stable key — which on a replicated
       * service is every replica of the same worker.
       */
      key: string;
    };

/** What a control call did. */
export interface WorkerControlResult {
  /** What was asked for. */
  desired: WorkerDesiredState;
  /** The workers it was written to, and the version each instruction got. */
  instances: {
    /** The incarnation's id. */
    id: string;
    /** The stored instruction's version, which the worker reports as `appliedSeq`. */
    seq: number;
    /** Whether that worker has been seen to apply it already. */
    applied: boolean;
  }[];
}

/** What a configuration call stored, and who it reaches. */
export interface WorkerConfigResult {
  /** The queue it is stored on. */
  queue: string;
  /** The stable worker key it applies to. */
  key: string;
  /** The override now stored; `{}` after a reset. */
  values: WorkerConfigOverride["values"];
  /** Its new version. */
  seq: number;
  /** When it was written, epoch ms. */
  updatedAt: number;
  /** Whether somebody else wrote first, so nothing changed. */
  contended: boolean;
  /** The live workers it reaches, and whether each has applied it yet. */
  instances: {
    /** The incarnation's id. */
    id: string;
    /** Whether that worker has applied this version. */
    applied: boolean;
  }[];
}

/**
 * A lifecycle instruction was refused because a worker it addresses is in a
 * state the instruction cannot be applied from — pausing a stopped worker,
 * say. Nothing was written.
 *
 * The library's counterpart of the management API's 409
 * `WORKER_STATE_CONFLICT`, with the same code: pausing a parked worker would
 * otherwise *start* it (a pause is only meaningful for a worker that runs),
 * which is the opposite of what the caller holding a stopped worker meant.
 */
export class WorkerStateConflictError extends JobsError {
  /** The action refused, and every addressed worker whose state refused it. */
  declare readonly context: {
    /** The action that was refused. */
    action: WorkerControlAction;
    /** Each worker whose state refused it, with that state. */
    workers: {
      /** The incarnation's id. */
      id: string;
      /** What it was doing when the call read it. */
      state: WorkerState;
    }[];
  };

  constructor(
    /** The action that was refused. */
    action: WorkerControlAction,
    /** Each worker whose state refused it, with that state. */
    workers: {
      /** The incarnation's id. */
      id: string;
      /** What it was doing when the call read it. */
      state: WorkerState;
    }[],
    /** What to do instead, e.g. `"start it first"`. */
    instead: string,
  ) {
    const first = workers[0]!;
    super(
      `Worker "${first.id}" cannot be ${action}d while it is ${first.state}${
        workers.length > 1 ? ` (and ${workers.length - 1} more)` : ""
      }: ${instead}`,
      "WORKER_STATE_CONFLICT",
      { action, workers },
    );
  }
}

/**
 * The states each lifecycle action is refused from, and what to do instead —
 * the same table the management API's lifecycle routes apply.
 */
const REFUSED_FROM: Partial<
  Record<
    WorkerControlAction,
    {
      /** States the action is refused from. */
      states: readonly WorkerState[];
      /** What to do instead, named in the error. */
      instead: string;
    }
  >
> = {
  pause: { states: ["stopped", "stopping"], instead: "start it first" },
  resume: { states: ["stopped", "stopping"], instead: "use start" },
};

/** Options for a {@link WorkerController}. */
export interface WorkerControllerOptions {
  /** The namespace the queue belongs to. */
  namespace: string;
  /** The queue whose workers this controls. */
  queue: string;
  /** The driver every read and write goes through. */
  driver: JobsDriver;
  /**
   * The workers registered in this process, so a call to one of them can be
   * made directly rather than through storage. Called each time, because a
   * context's workers come and go.
   */
  locals?: () => Iterable<LocalWorker>;
  /** Logger for publish failures, or anything `resolveLogger` accepts. */
  logger?: LoggerLike;
}

/**
 * Controls the workers of one queue, wherever they run.
 *
 * ```ts
 * const mail = jobs.workers.controller("mail");
 * await mail.pause({ key: "billing.mail" });   // every replica
 * await mail.setConfig("billing.mail", { concurrency: 16 });
 * await mail.stop({ id: liveWorker.id });      // one incarnation
 * ```
 *
 * The same shape as `RunnerController`, and for the same reason: everything goes
 * through what the workers already read, so no process has to be reachable
 * for a call to succeed. The event that follows each write is a hint that
 * saves a poll; the stored entry is the truth.
 *
 * Two levels of addressing, because a worker has two identities:
 *
 * - **Lifecycle** — pause, resume, stop, start — is addressed by incarnation
 *   (`{ id }`), or by key, which fans out to every live worker carrying it.
 *   An instruction records the incarnation it was written for, so it can
 *   never be applied by the process that replaced it: a deployment comes back
 *   running. A stop that should outlive a restart needs the worker's
 *   `stopPersistence: "key"`.
 * - **Configuration** is addressed by the stable key alone, so it survives
 *   restarts and reaches every replica — including one started tomorrow.
 */
export class WorkerController {
  /** The namespace the queue belongs to. */
  readonly namespace: string;
  /** The queue whose workers this controls. */
  readonly queue: string;
  /** The driver every read and write goes through. */
  readonly driver: JobsDriver;

  /** The workers registered in this process, if any. */
  readonly #locals: (() => Iterable<LocalWorker>) | undefined;
  /** Identifies this controller's `control` events. */
  readonly #origin = newToken();
  /** Logger for publish failures. */
  readonly #logger: Logger;

  constructor(options: WorkerControllerOptions) {
    this.namespace = assertNamespace(options.namespace);
    this.queue = assertSegment(options.queue, "queue name");
    this.driver = options.driver;
    this.#locals = options.locals;
    this.#logger = createJobsLogger(
      options.logger,
      { namespace: this.namespace, queue: this.queue },
      "worker-controller",
    );
  }

  /** The queue, as the driver wants it. */
  get ref(): QueueRef {
    return { ns: this.namespace, queue: this.queue };
  }

  /* --- reading ---------------------------------------------------------- */

  /** Every live worker on the queue, oldest first. */
  async list(): Promise<WorkerInfo[]> {
    await this.driver.connect();

    if (!supportsWorkers(this.driver)) {
      throw new NotSupportedError(this.driver.name, "listWorkers", {
        needs: "listWorkers()",
      });
    }

    return await listWorkerRecords(this.driver, this.ref, Date.now());
  }

  /** One live worker by its incarnation id, or `null`. */
  async get(id: string): Promise<WorkerInfo | null> {
    return (await this.list()).find((worker) => worker.id === id) ?? null;
  }

  /** Every configuration override stored on the queue, live or orphaned. */
  async listConfigs(): Promise<WorkerConfigOverride[]> {
    await this.driver.connect();
    return await listWorkerConfigs(this.driver, this.ref);
  }

  /** The override stored for one stable key; `values: {}` when there is none. */
  async getConfig(key: string): Promise<WorkerConfigOverride> {
    await this.driver.connect();
    const stored = await readWorkerConfig(this.driver, this.ref, key);

    return {
      queue: this.queue,
      key,
      values: stored?.value.values ?? {},
      seq: stored?.seq ?? 0,
      updatedAt: stored?.value.at ?? 0,
    };
  }

  /* --- lifecycle -------------------------------------------------------- */

  /**
   * Stops the target claiming. Jobs in flight carry on.
   *
   * Refused with a {@link WorkerStateConflictError} — before anything is
   * written — when an addressed worker is `stopped` or `stopping`: pausing
   * one would start it first, which is never what holding it parked meant.
   * Use {@link WorkerController.start}, then pause. For a `{ key }` target one
   * parked replica refuses the whole call; address the running ones by id.
   */
  async pause(target: WorkerSelector): Promise<WorkerControlResult> {
    return await this.#instruct(target, "paused", "pause");
  }

  /**
   * Resumes a paused target.
   *
   * Refused with a {@link WorkerStateConflictError} — before anything is
   * written — when an addressed worker is `stopped` or `stopping`: a parked
   * worker is brought back with {@link WorkerController.start}, which also calls
   * off a stop still draining. For a `{ key }` target one parked replica
   * refuses the whole call.
   */
  async resume(target: WorkerSelector): Promise<WorkerControlResult> {
    return await this.#instruct(target, "running", "resume");
  }

  /**
   * Parks the target: it stops claiming and doing maintenance, drains the
   * jobs it has, and stays registered and heartbeating so
   * {@link WorkerController.start} can reach it.
   *
   * How long that lasts is the *worker's* choice, not the caller's — it is
   * reported as `control.stopPersistence`. `persist` asks for the other one,
   * and is honoured only by a worker whose `stopPersistenceOverridable` is
   * on; elsewhere it is ignored, so a caller should read the worker's record
   * rather than assume.
   */
  async stop(
    target: WorkerSelector,
    options?: {
      /** Ask for a persistence other than the worker's own. */
      persist?: WorkerStopPersistence;
      /**
       * Abandon the jobs still running after this many milliseconds, rather
       * than waiting for them.
       *
       * An abandoned job's signal is aborted and its lock stops being
       * renewed, so the lock lapses and another worker recovers it as
       * stalled — the work is delayed and *run a second time from the start*,
       * which is why waiting indefinitely is the default. At most
       * `WORKER_STOP_TIMEOUT_MAX` (an hour); a value outside that is ignored
       * by the worker, which still stops, and says why in
       * `control.lastError`.
       */
      timeout?: number;
    },
  ): Promise<WorkerControlResult> {
    return await this.#instruct(target, "stopped", "stop", {
      ...(options?.persist === undefined ? {} : { persist: options.persist }),
      ...(options?.timeout === undefined ? {} : { timeout: options.timeout }),
    });
  }

  /** Brings a parked target back, and clears `paused` with it. */
  async start(target: WorkerSelector): Promise<WorkerControlResult> {
    return await this.#instruct(target, "running", "start");
  }

  /* --- configuration ----------------------------------------------------- */

  /**
   * Merges settings into the override stored for one stable key, and tells
   * its workers to re-read it. A setting given as `null` is removed, so the
   * worker's own value applies again.
   *
   * `expectedSeq` makes it a safe read-modify-write: the call reports
   * `contended: true` and changes nothing when somebody else has written
   * since the caller read. Without it, two callers editing different fields
   * both land, which is usually what they want.
   *
   * An unknown setting, or a value outside `WORKER_CONFIG_BOUNDS`, throws a
   * `ConfigError` naming it and the bound, and nothing is written — it used
   * to be dropped silently.
   */
  async setConfig(
    key: string,
    values: Readonly<Partial<Record<WorkerConfigKey, number | null>>>,
    options?: {
      /** Refuse unless the stored version is still this. */
      expectedSeq?: number;
    },
  ): Promise<WorkerConfigResult> {
    return await this.#storeConfig(key, values, "config", {
      ...(options?.expectedSeq === undefined
        ? {}
        : { expectedSeq: options.expectedSeq }),
    });
  }

  /**
   * Removes every override stored for one stable key, so its workers go back
   * to what their own code asks for.
   *
   * The entry is emptied rather than deleted: a deleted entry's version
   * restarts at 1, and a worker that had applied version 3 would then believe
   * it was up to date.
   */
  async resetConfig(key: string): Promise<WorkerConfigResult> {
    return await this.#storeConfig(key, {}, "reset", { replace: true });
  }

  /* --- internals --------------------------------------------------------- */

  /** Records what the target should be, and announces it. */
  async #instruct(
    target: WorkerSelector,
    desired: WorkerDesiredState,
    action: WorkerControlAction,
    stop: {
      /** Ask for a persistence other than the worker's own. */
      persist?: WorkerStopPersistence;
      /** Abandon the jobs still running after this many milliseconds. */
      timeout?: number;
    } = {},
  ): Promise<WorkerControlResult> {
    await this.driver.connect();
    this.#assertControllable();

    const workers = await this.#resolve(target);
    const refused = REFUSED_FROM[action];

    if (refused) {
      const conflicts = workers
        .map((worker) => ({ id: worker.id, state: stateOf(worker) }))
        .filter((worker) => refused.states.includes(worker.state));

      if (conflicts.length > 0) {
        throw new WorkerStateConflictError(action, conflicts, refused.instead);
      }
    }

    const instances: WorkerControlResult["instances"] = [];

    for (const worker of workers) {
      const { seq } = await writeWorkerControl(this.driver, this.ref, {
        id: worker.id,
        key: worker.key ?? worker.id,
        // A worker from before this existed reports no `processStartedAt`. It
        // has no control loop either, so the instruction will never be read;
        // `0` records that honestly rather than inventing an incarnation.
        incarnation: worker.processStartedAt ?? 0,
        state: desired,
        ...(stop.persist === undefined ? {} : { persist: stop.persist }),
        ...(stop.timeout === undefined ? {} : { timeout: stop.timeout }),
      });

      instances.push({
        id: worker.id,
        seq,
        applied: (worker.control?.appliedSeq ?? 0) >= seq,
      });

      // A worker in this process hears it without a round trip. It still
      // re-reads the stored entry, so this is only latency saved, never a
      // second path a local worker could take and one in another process
      // could not.
      void this.#local(worker.id)
        ?.syncControl()
        .catch(() => undefined);
    }

    await this.#announce(action, {
      ...("id" in target ? { worker: target.id } : { key: target.key }),
      seq: instances.at(-1)?.seq ?? 0,
    });

    return { desired, instances };
  }

  /** Writes an override and announces it. */
  async #storeConfig(
    key: string,
    values: Readonly<Partial<Record<WorkerConfigKey, number | null>>>,
    action: WorkerControlAction,
    options: {
      /** Refuse unless the stored version is still this. */
      expectedSeq?: number;
      /** Drop every stored field first. */
      replace?: boolean;
    },
  ): Promise<WorkerConfigResult> {
    await this.driver.connect();
    this.#assertControllable();
    assertSegment(key, "worker key");

    const { override, contended } = await writeWorkerConfig(
      this.driver,
      this.ref,
      key,
      values,
      options,
    );

    const instances = (await this.#live())
      .filter((worker) => (worker.key ?? worker.id) === key)
      .map((worker) => ({
        id: worker.id,
        applied: (worker.control?.configSeq ?? 0) >= override.seq,
      }));

    if (!contended) {
      await this.#announce(action, { key, seq: override.seq });
    }

    return { ...override, contended, instances };
  }

  /** The live workers an instruction is addressed to. */
  async #resolve(target: WorkerSelector): Promise<WorkerInfo[]> {
    const live = await this.#live();

    return "id" in target
      ? live.filter((worker) => worker.id === target.id)
      : live.filter((worker) => (worker.key ?? worker.id) === target.key);
  }

  /** Every live worker on the queue. */
  async #live(): Promise<WorkerInfo[]> {
    return supportsWorkers(this.driver)
      ? await listWorkerRecords(this.driver, this.ref, Date.now())
      : [];
  }

  /** The worker with that id, when it is registered in this process. */
  #local(id: string): LocalWorker | undefined {
    for (const worker of this.#locals?.() ?? []) {
      if (worker.id === id) {
        return worker;
      }
    }

    return undefined;
  }

  /** Refuses a call a driver cannot store. */
  #assertControllable(): void {
    if (!supportsWorkerControl(this.driver)) {
      throw new NotSupportedError(this.driver.name, "worker control", {
        needs: "getQueueState()/setQueueState()/listQueueState()",
      });
    }
  }

  /**
   * Publishes a `control` event, so workers following them re-read now rather
   * than at their next poll. The change is already stored, so a failure is
   * logged rather than thrown.
   *
   * Published whatever anybody's `publish` option says, like the runner's:
   * it is addressed to the processes that own the workers, not to dashboards.
   */
  async #announce(
    action: WorkerControlAction,
    addressed: {
      /** The incarnation it is addressed to. */
      worker?: string;
      /** The stable key it is addressed to. */
      key?: string;
      /** The stored entry's version. */
      seq: number;
    },
  ): Promise<void> {
    try {
      await this.driver.publish(
        workerEvent(
          {
            ns: this.namespace,
            target: this.queue,
            type: "control",
            origin: this.#origin,
          },
          { ...addressed, action },
        ),
      );
    } catch (error) {
      this.#logger.warn("Could not publish a worker control event", {
        error,
        action,
      });
    }
  }
}

/** What a worker is doing, falling back to its `paused` flag on an older record. */
function stateOf(worker: WorkerInfo): WorkerState {
  return worker.state ?? (worker.paused ? "paused" : "running");
}

/**
 * The workers of a namespace, and the controller for each queue's — the
 * counterpart of `jobs.runners`.
 */
export class WorkerControllerManager {
  /** The namespace it covers. */
  readonly namespace: string;

  /** The driver every read and write goes through. */
  readonly #driver: JobsDriver;
  /** The workers registered in this process. */
  readonly #locals: (() => Iterable<LocalWorker>) | undefined;
  /** Logger for the controllers it builds. */
  readonly #logger: LoggerLike | undefined;
  /** One controller per queue, since each is stateless but not free to build. */
  readonly #controllers = new Map<string, WorkerController>();

  constructor(options: {
    /** The namespace it covers. */
    namespace: string;
    /** The driver every read and write goes through. */
    driver: JobsDriver;
    /** The workers registered in this process. */
    locals?: () => Iterable<LocalWorker>;
    /** Logger for the controllers it builds, or anything `resolveLogger` accepts. */
    logger?: LoggerLike;
  }) {
    this.namespace = assertNamespace(options.namespace);
    this.#driver = options.driver;
    this.#locals = options.locals;
    this.#logger = options.logger;
  }

  /** The controller for one queue's workers. */
  controller(queue: string): WorkerController {
    const name = assertSegment(queue, "queue name");
    const existing = this.#controllers.get(name);

    if (existing) {
      return existing;
    }

    const controller = new WorkerController({
      namespace: this.namespace,
      queue: name,
      driver: this.#driver,
      ...(this.#locals === undefined ? {} : { locals: this.#locals }),
      ...(this.#logger === undefined ? {} : { logger: this.#logger }),
    });
    this.#controllers.set(name, controller);
    return controller;
  }
}
