/**
 * What a worker can be asked to be, and what can be changed about it.
 *
 * The one place these values are written down. The worker, the control
 * storage, the driver's {@link WorkerInfo} record and the management API's
 * browser-safe contract all describe the same five states and the same nine
 * settings, and they drift the moment any of them keeps its own copy. This
 * module is pure data — no imports, no side effects — so anything may depend
 * on it, including a module that must stay free of runtime imports and
 * restates these values rather than importing them.
 */

/**
 * Every state a worker reports.
 *
 * - `running` — claiming, or waiting for work to claim.
 * - `paused` — not claiming; jobs in flight carry on, the loop is alive and a
 *   resume is immediate.
 * - `stopping` — a stop was asked for and jobs in flight are still draining.
 * - `stopped` — parked: not claiming, no maintenance, still heartbeating so a
 *   controller can reach it. `run()`'s promise is still pending.
 * - `restarting` — a transient while a configuration change is applied in
 *   place; milliseconds, and no capacity is lost.
 */
export const WORKER_STATES = [
  "running",
  "paused",
  "stopping",
  "stopped",
  "restarting",
] as const;

/** One of {@link WORKER_STATES}. */
export type WorkerState = (typeof WORKER_STATES)[number];

/**
 * The worker settings an override may replace, in the order a form should
 * show them.
 *
 * Every one of them can be applied to a running worker in place, which is why
 * the list is exactly these nine: an option that could only take effect by
 * rebuilding the worker does not belong here.
 */
export const WORKER_CONFIG_KEYS = [
  "concurrency",
  "pollInterval",
  "maxBlock",
  "lockDuration",
  "heartbeatInterval",
  "stalledInterval",
  "maxStalledCount",
  "reportInterval",
  "drainDelay",
] as const;

/** One of {@link WORKER_CONFIG_KEYS}. */
export type WorkerConfigKey = (typeof WORKER_CONFIG_KEYS)[number];

/** Every editable worker setting, in milliseconds except the two counts. */
export type WorkerConfigValues = Record<WorkerConfigKey, number>;

/** An override: the settings it replaces, and nothing else. */
export type WorkerConfigPatch = Partial<WorkerConfigValues>;

/** What one setting must stay within. */
export interface WorkerConfigBound {
  /** The smallest value accepted, inclusive. */
  min: number;
  /** The largest value accepted, inclusive. */
  max: number;
}

/**
 * What an override may set each setting to. Exported so a UI builds its form
 * from the same numbers the worker enforces.
 *
 * Two of them are narrower than what code may ask for, on purpose:
 * `reportInterval` cannot be `0` remotely, because a worker that stops
 * reporting vanishes from the inventory and can never be reached again; and
 * `heartbeatInterval` is additionally bounded by
 * {@link workerConfigCrossFieldIssue} against the effective `lockDuration`,
 * because a renewal slower than the lock lets a running job's lock lapse and
 * the stalled sweep run it twice.
 */
export const WORKER_CONFIG_BOUNDS: Readonly<
  Record<WorkerConfigKey, WorkerConfigBound>
> = Object.freeze({
  concurrency: { min: 1, max: 1_000 },
  pollInterval: { min: 10, max: 3_600_000 },
  maxBlock: { min: 10, max: 3_600_000 },
  lockDuration: { min: 1_000, max: 86_400_000 },
  heartbeatInterval: { min: 100, max: 43_200_000 },
  stalledInterval: { min: 1_000, max: 86_400_000 },
  maxStalledCount: { min: 0, max: 100 },
  reportInterval: { min: 1_000, max: 600_000 },
  drainDelay: { min: 0, max: 86_400_000 },
});

/** The settings that must be whole numbers; the rest are milliseconds. */
const WORKER_CONFIG_INTEGERS: ReadonlySet<WorkerConfigKey> = new Set([
  "concurrency",
  "maxStalledCount",
]);

/** Whether `value` is one of {@link WORKER_CONFIG_KEYS}. */
export function isWorkerConfigKey(value: string): value is WorkerConfigKey {
  return (WORKER_CONFIG_KEYS as readonly string[]).includes(value);
}

/** Whether `value` is one of {@link WORKER_STATES}. */
export function isWorkerState(value: string): value is WorkerState {
  return (WORKER_STATES as readonly string[]).includes(value);
}

/**
 * Why `value` is not acceptable for `key`, or `null` when it is.
 *
 * A message rather than a thrown error: an override is applied field by
 * field, and one bad field must never stop a worker from running or from
 * applying the others.
 */
export function workerConfigIssue(
  key: WorkerConfigKey,
  value: unknown,
): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `${key} must be a finite number`;
  }

  if (WORKER_CONFIG_INTEGERS.has(key) && !Number.isInteger(value)) {
    return `${key} must be a whole number`;
  }

  const { min, max } = WORKER_CONFIG_BOUNDS[key];

  if (value < min || value > max) {
    return `${key} must be between ${min} and ${max}`;
  }

  return null;
}

/**
 * Why a whole set of settings cannot hold together, or `null` when it can.
 *
 * The one rule that spans two fields: a lock renewed less often than half the
 * time it lives can lapse under a job that is still running. Checked against
 * the *merged* effective values, because an override of either field alone is
 * enough to break the pair.
 */
export function workerConfigCrossFieldIssue(
  values: Pick<WorkerConfigValues, "heartbeatInterval" | "lockDuration">,
): {
  /** Which field to blame. */ key: WorkerConfigKey;
  /** Why. */ message: string;
} | null {
  if (values.heartbeatInterval > values.lockDuration / 2) {
    return {
      key: "heartbeatInterval",
      message: `heartbeatInterval must be at most half of lockDuration (${Math.floor(
        values.lockDuration / 2,
      )}ms)`,
    };
  }

  return null;
}

/** What a worker `control` event says a controller asked for. */
export const WORKER_CONTROL_ACTIONS = [
  "pause",
  "resume",
  "stop",
  "start",
  "config",
  "reset",
] as const;

/** One of {@link WORKER_CONTROL_ACTIONS}. */
export type WorkerControlAction = (typeof WORKER_CONTROL_ACTIONS)[number];

/** The names of the events the `worker` event kind carries. */
export const WORKER_EVENT_TYPES = ["control", "state", "config"] as const;

/** One of {@link WORKER_EVENT_TYPES}. */
export type WorkerEventName = (typeof WORKER_EVENT_TYPES)[number];

/**
 * The lifecycle instruction a controller may record against a worker: what it
 * should be, rather than what it is. `stopping` and `restarting` are states a
 * worker passes through, never things to ask for.
 */
export type WorkerDesiredState = Exclude<
  WorkerState,
  "stopping" | "restarting"
>;

/**
 * How long a stop lasts.
 *
 * - `process` (the default) — the stop is recorded against the worker's
 *   **incarnation**, so a process restart brings it back running. A deployment
 *   must not come back with every worker silently stopped.
 * - `key` — the stop is recorded against the worker's stable key as well, and
 *   a worker with that key applies it at startup. "Stopped until somebody
 *   starts it", across restarts and replicas.
 */
export const WORKER_STOP_PERSISTENCE = ["process", "key"] as const;

/** One of {@link WORKER_STOP_PERSISTENCE}. */
export type WorkerStopPersistence = (typeof WORKER_STOP_PERSISTENCE)[number];

/** How a worker hears about a control change. */
export type WorkerControlMode = "subscribe" | "poll";
