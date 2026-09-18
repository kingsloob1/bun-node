import type { SerializedError } from "@kingsleyweb/bun-common";
import type {
  DriverEvent,
  QueueEventName,
  QueueEventPayloads,
  RunnerEventName,
  RunnerEventPayloads,
} from "../../shared/events";
import type { ErrorWire, EventWire } from "../contract/ws";
import type { Infer, Schema } from "../schema/builder";
import { s } from "../schema/builder";
import { ErrorDtoSchema, JOB_STATES } from "../schemas/common";

/**
 * The schema of every event the socket carries, by name.
 *
 * The two tables below are declared with `satisfies` over the payload
 * interfaces in `shared/events.ts`, so adding an event there without adding
 * its schema here is a compile error, and so is a schema whose shape has
 * drifted from the payload it describes (checked both ways, below). The
 * AsyncAPI document and the server-message validator are both built from
 * these tables, so neither can describe an event the code does not send.
 */

/** Whether two types are mutually assignable. */
export type Equivalent<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

/** Whether two types are identical, not merely mutually assignable. */
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;

/** Flattens intersections all the way down, so {@link Equal} compares plain shapes. */
type Flatten<T> = T extends (infer U)[]
  ? Flatten<U>[]
  : T extends object
    ? { [K in keyof T]: Flatten<T[K]> }
    : T;

/** Every distinct event name (`failed` is both a queue and a runner event): defined in the browser-safe contract. */
export { EVENT_TYPES } from "../contract/constants";

/**
 * A payload as it leaves the process: every `SerializedError` field becomes an
 * {@link ErrorWire} (its `stack` stripped unless `serialize.exposeStacks`).
 *
 * A `never` field is left alone: an empty payload (`Record<string, never>`,
 * `paused`/`resumed`) has one, and `never extends SerializedError` holds, so
 * without the guard it would become an index signature of errors — which a
 * client's `Record<string, never>` is not.
 */
export type WirePayload<T> = {
  [K in keyof T]: [T[K]] extends [never]
    ? T[K]
    : T[K] extends SerializedError
      ? ErrorWire
      : T[K];
};

/** One driver event as a client receives it: `ns` and `origin` dropped, payload errors shaped. */
type WireEventOf<E> = E extends { payload: infer P }
  ? Omit<E, "ns" | "origin" | "payload"> & {
      /** What the event carries, every error in it shaped as an `ErrorDto`. */
      payload: WirePayload<P>;
    }
  : never;

/**
 * Any event as the server derives it from `DriverEvent`: `ns` and `origin`
 * dropped, and a payload's `error` the `ErrorDto` a client actually receives
 * (`stack` only with `serialize.exposeStacks`), not the in-process
 * `SerializedError`. Must be exactly the contract's {@link EventWire}.
 */
type DerivedEventWire = WireEventOf<DriverEvent>;

/**
 * Compile-time guard that the events the server derives are exactly the
 * contract's `EventWire`, and its errors the `Error` schema's type: an event
 * or payload field added in `shared/events.ts` and not in `contract/ws.ts`
 * (or the reverse) fails here.
 */
const _eventWireMatches: [
  Equal<Flatten<DerivedEventWire>, Flatten<EventWire>>,
  Equal<Flatten<Infer<typeof ErrorDtoSchema>>, Flatten<ErrorWire>>,
] = [true, true];

/** A job id. */
const JobId = s.string({ description: "The job's id." });
/** Several job ids. */
const JobIds = s.array(s.string(), { description: "The jobs' ids." });
/** A run id. */
const RunId = s.string({ description: "The run's id." });
/** An epoch-ms instant. */
const EpochMs = (description: string) => s.integer({ description });

/** What each queue event carries on the wire. */
export const QUEUE_EVENT_PAYLOADS = {
  added: s.object({ id: JobId }),
  duplicate: s.object({ id: JobId }),
  waiting: s.object({ id: JobId }),
  delayed: s.object({
    id: JobId,
    runAt: EpochMs("When it becomes claimable, epoch ms."),
  }),
  active: s.object({ id: JobId }),
  progress: s.object({
    id: JobId,
    progress: s.unknown({ description: "The progress value, as reported." }),
  }),
  completed: s.object({
    id: JobId,
    returnValue: s.unknown({ description: "The processor's return value." }),
  }),
  failed: s.object({ id: JobId, error: ErrorDtoSchema }),
  retrying: s.object({
    id: JobId,
    error: ErrorDtoSchema,
    runAt: EpochMs("When the next attempt is due, epoch ms."),
  }),
  dead: s.object({ id: JobId, error: ErrorDtoSchema }),
  stalled: s.object({ ids: JobIds }),
  removed: s.object({ id: JobId }),
  promoted: s.object({ id: JobId }),
  paused: s.object({}),
  resumed: s.object({}),
  drained: s.object({
    count: s.integer({ minimum: 0, description: "Jobs dropped." }),
  }),
  cleaned: s.object({ ids: JobIds, state: s.enum(JOB_STATES) }),
  retried: s.object({ ids: JobIds }),
  debounced: s.object({ id: JobId }),
  throttled: s.object({ id: JobId }),
  repeatScheduled: s.object({
    key: s.string({ description: "The repeat series' key." }),
    nextRunAt: EpochMs("When the next occurrence runs, epoch ms."),
  }),
} satisfies {
  [K in QueueEventName]: Schema<WirePayload<QueueEventPayloads[K]>, any>;
};

/** What each runner event carries on the wire. */
export const RUNNER_EVENT_PAYLOADS = {
  control: s.object({
    action: s.enum(["pause", "resume", "schedule", "trigger"]),
  }),
  started: s.object({ runId: RunId }),
  succeeded: s.object({
    runId: RunId,
    durationMs: s.number({ minimum: 0, description: "How long it ran." }),
  }),
  failed: s.object({ runId: RunId, error: ErrorDtoSchema }),
  queued: s.object({ runId: RunId }),
  skipped: s.object({
    reason: s.string({ description: "Why it was skipped." }),
  }),
  timeout: s.object({ runId: RunId }),
  killed: s.object({
    runId: RunId,
    reason: s.string({ description: "The reason it was given." }),
  }),
} satisfies {
  [K in RunnerEventName]: Schema<WirePayload<RunnerEventPayloads[K]>, any>;
};

/** Queue events whose schema is looser or stricter than the payload type. */
type QueueMismatch = {
  [K in QueueEventName]: Equivalent<
    Infer<(typeof QUEUE_EVENT_PAYLOADS)[K]>,
    WirePayload<QueueEventPayloads[K]>
  > extends true
    ? never
    : K;
}[QueueEventName];

/** Runner events whose schema is looser or stricter than the payload type. */
type RunnerMismatch = {
  [K in RunnerEventName]: Equivalent<
    Infer<(typeof RUNNER_EVENT_PAYLOADS)[K]>,
    WirePayload<RunnerEventPayloads[K]>
  > extends true
    ? never
    : K;
}[RunnerEventName];

/**
 * Compile-time guard that every schema describes exactly its payload: a field
 * added to or removed from a payload in `shared/events.ts` fails this line,
 * naming the event.
 */
const _payloadSchemasMatch: [QueueMismatch | RunnerMismatch] extends [never]
  ? true
  : QueueMismatch | RunnerMismatch = true;

/** One line per queue event, for the documents. */
const QUEUE_EVENT_SUMMARIES: Record<QueueEventName, string> = {
  added: "A job was added.",
  duplicate: "An add matched an existing id, so nothing was added.",
  waiting: "A job became claimable.",
  delayed: "A job was added for later.",
  active: "A worker claimed a job.",
  progress: "A job reported progress (coalesced per job).",
  completed: "A job completed.",
  failed: "An attempt failed.",
  retrying: "An attempt failed and another is due.",
  dead: "A job exhausted its attempts, or failed unrecoverably.",
  stalled: "Jobs were recovered from workers that died holding them.",
  removed: "A job was removed.",
  promoted: "A job was made claimable early.",
  paused: "The queue was paused.",
  resumed: "The queue was resumed.",
  drained: "Pending jobs were dropped.",
  cleaned: "Finished jobs were removed.",
  retried: "Finished jobs were returned to the queue together.",
  debounced: "An add replaced a pending debounced job's data.",
  throttled: "An add fell inside a throttle window, so nothing was added.",
  repeatScheduled: "A repeat series scheduled its next occurrence.",
};

/** One line per runner event, for the documents. */
const RUNNER_EVENT_SUMMARIES: Record<RunnerEventName, string> = {
  control: "A controller changed the runner's state or queued a trigger.",
  started: "A run began.",
  succeeded: "A run finished successfully.",
  failed: "A run failed.",
  queued: "A run was asked for while another held the lock.",
  skipped: "A scheduled run was skipped.",
  timeout: "A run outlived its timeout.",
  killed: "A run was stopped on request.",
};

/** Every queue event name, in declaration order. */
export const QUEUE_EVENT_NAMES = Object.keys(
  QUEUE_EVENT_PAYLOADS,
) as QueueEventName[];

/** Every runner event name, in declaration order. */
export const RUNNER_EVENT_NAMES = Object.keys(
  RUNNER_EVENT_PAYLOADS,
) as RunnerEventName[];

/**
 * The error and event types an `event` frame carries: defined once, in the
 * browser-safe contract, and re-exported here so the server builds exactly
 * what a client imports.
 */
export type { ErrorWire, EventWire } from "../contract/ws";

/** `repeatScheduled` → `RepeatScheduled`. */
function pascal(name: string): string {
  return `${name[0]!.toUpperCase()}${name.slice(1)}`;
}

/** One event as the socket describes it. */
export interface EventDescriptor {
  /** Which subsystem emits it. */
  kind: "queue" | "runner";
  /** The event name. */
  type: string;
  /** The AsyncAPI message name, e.g. `"queue.completed"`. */
  messageName: string;
  /** One-line summary. */
  summary: string;
  /** The payload schema, named `<Kind><Type>Payload`. */
  payload: Schema<unknown>;
  /** The event DTO schema (`EventDto` for this event), named `<Kind><Type>Event`. */
  event: Schema<unknown>;
}

/** Builds the descriptor for one event. */
function describe(
  kind: "queue" | "runner",
  type: string,
  payload: Schema<any>,
  summary: string,
): EventDescriptor {
  const base = `${pascal(kind)}${pascal(type)}`;
  const named = s.named(`${base}Payload`, payload);
  return {
    kind,
    type,
    messageName: `${kind}.${type}`,
    summary,
    payload: named,
    event: s.named(
      `${base}Event`,
      s.object(
        {
          v: s.literal(1, { description: "Envelope version." }),
          kind: s.literal(kind),
          type: s.literal(type),
          target: s.string({
            description:
              kind === "queue" ? "The queue name." : "The runner id.",
          }),
          id: s.optional(
            s.string({
              description:
                kind === "queue"
                  ? "The job this event is about, where it is about one."
                  : "The run this event is about, where it is about one.",
            }),
          ),
          at: s.integer({ description: "When it was emitted, epoch ms." }),
          payload: named,
        },
        { description: summary },
      ),
    ),
  };
}

/** Every queue event's descriptor. */
export const QUEUE_EVENTS: readonly EventDescriptor[] = QUEUE_EVENT_NAMES.map(
  (type) =>
    describe(
      "queue",
      type,
      QUEUE_EVENT_PAYLOADS[type],
      QUEUE_EVENT_SUMMARIES[type],
    ),
);

/** Every runner event's descriptor. */
export const RUNNER_EVENTS: readonly EventDescriptor[] = RUNNER_EVENT_NAMES.map(
  (type) =>
    describe(
      "runner",
      type,
      RUNNER_EVENT_PAYLOADS[type],
      RUNNER_EVENT_SUMMARIES[type],
    ),
);

/** Any event as a client receives it: one of the event DTO schemas. */
export const EventDtoSchema = s.union(
  ...([...QUEUE_EVENTS, ...RUNNER_EVENTS].map((event) => event.event) as [
    Schema<unknown>,
    ...Schema<unknown>[],
  ]),
);
