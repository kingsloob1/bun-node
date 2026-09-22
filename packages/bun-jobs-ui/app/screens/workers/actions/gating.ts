import type { JobsApiAction } from "../../../api/contract";
import type { WorkerDto } from "../../../api/types";
import { isControllable, isStale, workerState } from "../../../api/workers";
import { useMeta } from "../../../meta/hooks";
import { useCanMutate } from "../../queues/gating";

/**
 * Which worker actions are offered. Lifecycle actions target one running
 * worker (its per-incarnation `id`); Configure… targets the stable `key`, so
 * it needs one.
 */
export interface WorkerActionGates {
  /** `workers.pause`, on a running worker. */
  pause: boolean;
  /** `workers.resume`, on a paused worker. */
  resume: boolean;
  /** `workers.stop`, on a running or paused worker. */
  stop: boolean;
  /** `workers.start`, on a stopped worker. */
  start: boolean;
  /** `workers.configure` (opt-in), when the worker reports the stable key an override is stored against. */
  configure: boolean;
  /**
   * Why no lifecycle action is offered although the caller holds the
   * permissions: the record has lapsed, the worker is mid-transition, or the
   * API cannot reach it. `null` when there is nothing to explain.
   */
  blocked: "stale" | "transitioning" | "uncontrollable" | null;
}

/**
 * The actions to offer for `worker`, given a predicate that is true only for
 * a permitted action on a writable API (`useCanMutate`).
 *
 * A worker in `stopping` or `restarting` is between states, so it is offered
 * nothing until it settles; a lapsed record (`stale`) means nobody is there
 * to act on the instruction; and an API that reports `control.enabled: false`
 * — remote control switched off, or a worker from an older release — cannot
 * be controlled at all. Configure… stays available while stale, because an
 * override is stored for whichever replica comes up next.
 */
export function workerActionGates(
  worker: WorkerDto,
  canMutate: (action: JobsApiAction) => boolean,
  now = Date.now(),
): WorkerActionGates {
  const state = workerState(worker);
  const stale = isStale(worker, now);
  const controllable = isControllable(worker);
  const transitioning = state === "stopping" || state === "restarting";
  const live = controllable && !stale && !transitioning;
  return {
    pause: live && state === "running" && canMutate("workers.pause"),
    resume: live && state === "paused" && canMutate("workers.resume"),
    stop:
      live &&
      (state === "running" || state === "paused") &&
      canMutate("workers.stop"),
    start: live && state === "stopped" && canMutate("workers.start"),
    configure:
      controllable &&
      worker.key !== undefined &&
      canMutate("workers.configure"),
    blocked: !controllable
      ? "uncontrollable"
      : stale
        ? "stale"
        : transitioning
          ? "transitioning"
          : null,
  };
}

/**
 * Whether a row says why it offers no lifecycle action: the worker's state is
 * the reason (`gates.blocked`) **and** the caller holds the lifecycle
 * permission, so the gap is the worker's doing, not the caller's lack of
 * permission (which is the ordinary case, and says nothing). Independent of
 * Settings…, which stays offered while a worker is stale or mid-transition.
 */
export function explainsBlock(
  gates: WorkerActionGates,
  canMutate: (action: JobsApiAction) => boolean,
): boolean {
  return gates.blocked !== null && canMutate("workers.pause");
}

/** Why a worker offers no lifecycle action, as a sentence for a title attribute. */
export const WORKER_BLOCKED_HINT: Readonly<
  Record<NonNullable<WorkerActionGates["blocked"]>, string>
> = {
  stale:
    "This worker stopped reporting, so nothing would receive the instruction. Its record lapses shortly.",
  transitioning:
    "This worker is between states. Its actions come back once it settles.",
  uncontrollable:
    "This API cannot control this worker: remote control is off for it, or it runs an older release that does not listen for instructions.",
};

/**
 * Whether a worker mutation is offered here: the caller holds it, the API is
 * writable (`useCanMutate`), **and** the backend supports worker control
 * (`meta.features.workerControl`). Without that support the API prunes the
 * control routes altogether, so a button would only ever 404.
 */
export function useCanControlWorkers(): (action: JobsApiAction) => boolean {
  const meta = useMeta();
  const canMutate = useCanMutate();
  return (action) => meta.features.workerControl && canMutate(action);
}
