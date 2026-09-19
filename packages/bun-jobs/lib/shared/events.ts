import type { SerializedError } from "@kingsleyweb/bun-common";
import type { JobState } from "../drivers/driver";
import type { RunProgress } from "./progress";

/**
 * What crosses a process boundary, and what shape it has.
 *
 * The envelope used to be `type: string` with `payload?: unknown`, which meant
 * a subscriber learned nothing from the types and a publisher could put
 * anything anywhere. Worse, the receiving side reconstructed *every* event the
 * same way — fetch the job named by `id`, emit `(job)` — so an event whose
 * local signature took anything else was wrong the moment it crossed: `removed`
 * and `promoted` emitted a string locally and a `Job` remotely, and `delayed`,
 * `completed` and `retrying` simply lost their second argument.
 *
 * Naming the payload per event fixes both halves at once. The union is
 * discriminated on `kind` and then on `type`, so a `switch` in a subscriber
 * narrows to exactly the fields that event carries.
 *
 * **Payloads stay small on purpose.** Some transports cap a message at a few
 * kilobytes — Redis pub/sub is the practical limit here — so an event carries
 * the job's *id* and whatever scalars the signature needs, never the record.
 * A listener that wants the job fetches it, and only when someone is actually
 * listening for that event.
 *
 * Everything here must survive `JSON.stringify` and come back equal. That is
 * why errors travel as {@link SerializedError} rather than as `Error`: the
 * local side hands listeners a real `Error`, and the boundary is where the two
 * representations meet.
 */

/** An event carrying nothing beyond the fact that it happened. */
export type EmptyPayload = Record<string, never>;

/** What each queue event carries on the wire, by name. */
export interface QueueEventPayloads {
  /** A job was added. */
  added: { id: string };
  /** An `add()` matched an existing id, so nothing was added. */
  duplicate: { id: string };
  /** A job became claimable. */
  waiting: { id: string };
  /** A job was added for later. */
  delayed: { id: string; runAt: number };
  /** A worker claimed a job. */
  active: { id: string };
  /** A job reported progress. */
  progress: { id: string; progress: RunProgress };
  /** A job completed. */
  completed: { id: string; returnValue: unknown };
  /** An attempt failed. */
  failed: { id: string; error: SerializedError };
  /** An attempt failed and another is due. */
  retrying: { id: string; error: SerializedError; runAt: number };
  /** A job exhausted its attempts, or failed unrecoverably. */
  dead: { id: string; error: SerializedError };
  /** Jobs were recovered from workers that died holding them. */
  stalled: { ids: string[] };
  /** A job was removed. */
  removed: { id: string };
  /** A job was made claimable early. */
  promoted: { id: string };
  /** The queue was paused. */
  paused: EmptyPayload;
  /** The queue was resumed. */
  resumed: EmptyPayload;
  /** Pending jobs were dropped. */
  drained: { count: number };
  /** Finished jobs were removed. */
  cleaned: { ids: string[]; state: JobState };
  /** Finished jobs were returned to the queue together. */
  retried: { ids: string[] };
  /** An add replaced a pending debounced job's data instead of adding one. */
  debounced: { id: string };
  /** An add fell inside a throttle window, so nothing was added. */
  throttled: { id: string };
  /** A repeat series scheduled its next occurrence. */
  repeatScheduled: { key: string; nextRunAt: number };
}

/**
 * What a `control` event says changed: a remote controller paused, resumed or
 * rescheduled a runner, or queued a trigger for it.
 */
export type RunnerControlAction = "pause" | "resume" | "schedule" | "trigger";

/** What each runner event carries on the wire, by name. */
export interface RunnerEventPayloads {
  /**
   * A controller (`BunRunnerManager.remote()`) changed the runner's persisted
   * state or queued a trigger. Published whatever the runner's `publish`
   * option says, because it is addressed to the processes that own the
   * runner: one started with `remoteControl` re-reads its state on hearing it.
   */
  control: { action: RunnerControlAction };
  /** A run began. */
  started: { runId: string };
  /** A run finished successfully. */
  succeeded: { runId: string; durationMs: number };
  /** A run failed. */
  failed: { runId: string; error: SerializedError };
  /** A run was asked for while another held the lock. */
  queued: { runId: string };
  /** A scheduled run was skipped. */
  skipped: { reason: string };
  /** A run outlived its timeout. */
  timeout: { runId: string };
  /** A run was stopped on request, with the reason it was given. */
  killed: { runId: string; reason: string };
}

/** The name of any queue event. */
export type QueueEventName = keyof QueueEventPayloads;

/** The name of any runner event. */
export type RunnerEventName = keyof RunnerEventPayloads;

/** Fields every envelope carries, whatever it is about. */
interface EventEnvelope {
  /** Envelope version, so a rolling upgrade can tell shapes apart. */
  v: 1;
  /** The namespace it belongs to. Subscribers ignore anything else. */
  ns: string;
  /** The queue name or runner id. */
  target: string;
  /** When it was emitted, in epoch milliseconds. */
  at: number;
  /** Token of the emitting process, so it can ignore its own echoes. */
  origin: string;
}

/** One queue event, with the payload its name implies. */
export type QueueDriverEvent = {
  [Name in QueueEventName]: EventEnvelope & {
    /** Which subsystem emitted it. */
    kind: "queue";
    /** The event name, which selects the payload's shape. */
    type: Name;
    /** The job this event is about, where it is about one. */
    id?: string;
    /** What this event carries. */
    payload: QueueEventPayloads[Name];
  };
}[QueueEventName];

/** One runner event, with the payload its name implies. */
export type RunnerDriverEvent = {
  [Name in RunnerEventName]: EventEnvelope & {
    /** Which subsystem emitted it. */
    kind: "runner";
    /** The event name, which selects the payload's shape. */
    type: Name;
    /** The run this event is about, where it is about one. */
    id?: string;
    /** What this event carries. */
    payload: RunnerEventPayloads[Name];
  };
}[RunnerEventName];

/** Anything a driver may be asked to publish or deliver. */
export type DriverEvent = QueueDriverEvent | RunnerDriverEvent;

/** Which subsystem an event came from. */
export type EventKind = DriverEvent["kind"];

/** The events one subsystem can produce, for a subscriber of that kind. */
export type EventOfKind<TKind extends EventKind> = Extract<
  DriverEvent,
  { kind: TKind }
>;

/**
 * Builds a queue event, with the payload checked against its name.
 *
 * The point of the overload-free generic: `type` picks the payload, so a
 * mismatched pair is a compile error at the call site rather than a surprise
 * in a subscriber three processes away.
 */
export function queueEvent<Name extends QueueEventName>(
  event: {
    /** The namespace it belongs to. */
    ns: string;
    /** The queue it is about. */
    target: string;
    /** The event name. */
    type: Name;
    /** Token of the emitting process. */
    origin: string;
    /** When it happened; defaults to now. */
    at?: number;
  },
  payload: QueueEventPayloads[Name],
): QueueDriverEvent {
  return {
    v: 1,
    ns: event.ns,
    kind: "queue",
    target: event.target,
    type: event.type,
    // Kept alongside the payload because a transport may index on it, and
    // because it is the one field every job event shares.
    ...("id" in payload ? { id: (payload as { id: string }).id } : {}),
    at: event.at ?? Date.now(),
    origin: event.origin,
    payload,
  } as QueueDriverEvent;
}

/**
 * Builds a runner event, with the payload checked against its name — the
 * runner's counterpart of {@link queueEvent}.
 */
export function runnerEvent<Name extends RunnerEventName>(
  event: {
    /** The namespace it belongs to. */
    ns: string;
    /** The runner it is about. */
    target: string;
    /** The event name. */
    type: Name;
    /** Token of the emitting process. */
    origin: string;
    /** When it happened; defaults to now. */
    at?: number;
  },
  payload: RunnerEventPayloads[Name],
): RunnerDriverEvent {
  return {
    v: 1,
    ns: event.ns,
    kind: "runner",
    target: event.target,
    type: event.type,
    ...("runId" in payload ? { id: (payload as { runId: string }).runId } : {}),
    at: event.at ?? Date.now(),
    origin: event.origin,
    payload,
  } as RunnerDriverEvent;
}

/**
 * Whether a decoded message is an envelope this version understands.
 *
 * A driver reads these off a wire it does not control — a Redis channel, a
 * table, a file another process appends to — so a malformed or
 * future-versioned message has to be dropped rather than delivered as a
 * half-typed object.
 */
export function isDriverEvent(value: unknown): value is DriverEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const event = value as Partial<DriverEvent>;

  return (
    event.v === 1 &&
    typeof event.ns === "string" &&
    (event.kind === "queue" || event.kind === "runner") &&
    typeof event.target === "string" &&
    typeof event.type === "string" &&
    typeof event.at === "number" &&
    typeof event.origin === "string" &&
    typeof event.payload === "object" &&
    event.payload !== null
  );
}
