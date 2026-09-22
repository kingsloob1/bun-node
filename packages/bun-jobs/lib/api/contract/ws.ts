import type {
  EventName,
  JobsApiMode,
  JobState,
  QueueEventName,
  RunnerEventName,
  WorkerConfigKey,
  WorkerControlAction,
  WorkerEventName,
  WorkerState,
} from "./constants";
import type { RunProgress } from "./types";

/**
 * The live-events socket's wire protocol as named types: every frame a client
 * sends and every frame the server sends, and every event an `event` frame
 * carries.
 *
 * **Browser-safe**: imports only its sibling `constants.ts`, type-only.
 * **One definition**: the server defines none of these itself.
 * `lib/api/ws/protocol.ts` and `ws/events.ts` import and re-export them, so
 * the root entry's socket types are these very types. What the server
 * derives (the event payloads from `shared/events.ts`, the frame schemas) is
 * held equal to them at compile time, in `ws/events.ts`, `ws/protocol.ts` and
 * `__tests__/api/api-contract.type-test.ts`.
 */

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

/**
 * An error as an event carries it: the `Error` schema's shape. `cause` is
 * loose because the schema cannot recurse; it holds an error of this shape.
 */
export interface ErrorWire {
  /** The error's class name. */
  name: string;
  /** The error's message. */
  message: string;
  /** Its `code`, when it had one. */
  code?: string | number;
  /** The stack; only with `serialize.exposeStacks`. */
  stack?: string;
  /** Extra own properties the error carried. */
  data?: Record<string, unknown>;
  /** The cause, shaped as an error. */
  cause?: unknown;
}

/** What each queue event carries, by name. */
export interface QueueEventPayloadsWire {
  /** A job was added. */
  added: { id: string };
  /** An add matched an existing id, so nothing was added. */
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
  failed: { id: string; error: ErrorWire };
  /** An attempt failed and another is due. */
  retrying: { id: string; error: ErrorWire; runAt: number };
  /** A job exhausted its attempts, or failed unrecoverably. */
  dead: { id: string; error: ErrorWire };
  /** Jobs were recovered from workers that died holding them. */
  stalled: { ids: string[] };
  /** A job was removed. */
  removed: { id: string };
  /** A job was made claimable early. */
  promoted: { id: string };
  /** The queue was paused. Carries nothing. */
  paused: Record<string, never>;
  /** The queue was resumed. Carries nothing. */
  resumed: Record<string, never>;
  /** Pending jobs were dropped. */
  drained: { count: number };
  /** Finished jobs were removed. */
  cleaned: { ids: string[]; state: JobState };
  /** Finished jobs were returned to the queue together. */
  retried: { ids: string[] };
  /** An add replaced a pending debounced job's data. */
  debounced: { id: string };
  /** An add fell inside a throttle window, so nothing was added. */
  throttled: { id: string };
  /** A repeat series scheduled its next occurrence. */
  repeatScheduled: { key: string; nextRunAt: number };
}

/** What each runner event carries, by name. */
export interface RunnerEventPayloadsWire {
  /**
   * A controller changed the runner's state, queued a trigger, or changed its
   * executor and overlap configuration (`config`).
   */
  control: {
    action: "pause" | "resume" | "schedule" | "trigger" | "config";
  };
  /** A run began. */
  started: { runId: string };
  /** A run finished successfully. */
  succeeded: { runId: string; durationMs: number };
  /** A run failed. */
  failed: { runId: string; error: ErrorWire };
  /** A run was asked for while another held the lock. */
  queued: { runId: string };
  /** A scheduled run was skipped. */
  skipped: { reason: string };
  /** A run outlived its timeout. */
  timeout: { runId: string };
  /** A run was stopped on request, with the reason it was given. */
  killed: { runId: string; reason: string };
  /**
   * A run's stored log grew. A **hint, never the lines**: re-read
   * `GET /runners/:runner/runs/:runId/logs?since=<the last seq you hold>`.
   * Published on the runner's channel (`runner/{runner}`, and `runners` and
   * `all`), at most one per run every 500 ms carrying the newest `lastSeq`,
   * plus one when the run settles. A missed hint costs latency, never lines:
   * the next read with `since` returns everything after what you hold.
   *
   * **Not a state change.** `logs` announces log growth only and changes no
   * runner state, so a client caching runner detail, stats or history should
   * not invalidate them on it; re-read the run's log with `?since=` instead.
   * It can arrive twice a second per running run (`RUN_LOG_HINT_MS`).
   */
  logs: {
    /** The run whose log grew. */
    runId: string;
    /** The `seq` of the last line the store now holds for that run. */
    lastSeq: number;
  };
}

/**
 * What each worker event carries, by name.
 *
 * A worker event's `target` is the **queue**, never a worker id: one channel
 * per queue lets a process with several workers on it share one subscription,
 * and keeps worker traffic out of the queue's job firehose.
 *
 * As with a runner's `control`, an event is only ever a **hint** — the
 * receiver re-reads the stored entry, which is the truth. A missed event
 * therefore costs latency, never correctness.
 */
export interface WorkerEventPayloadsWire {
  /** A controller recorded an instruction for one worker, or for every worker carrying a key. */
  control: {
    /** The incarnation it is addressed to, when it is addressed to one. */
    worker?: string;
    /** The stable key it is addressed to, when it is addressed to one. */
    key?: string;
    /** What was asked for. */
    action: WorkerControlAction;
    /** The version of the entry the controller wrote. */
    seq: number;
  };
  /** A worker changed what it is doing. */
  state: {
    /** The worker's incarnation id. */
    worker: string;
    /** Its stable key. */
    key: string;
    /** What it is now. */
    state: WorkerState;
    /** What it was. */
    previous: WorkerState;
    /** Why, where there is anything to add. */
    reason?: string;
    /** When it changed, epoch ms. */
    at: number;
  };
  /** A worker adopted — or refused part of — a configuration override. */
  config: {
    /** The worker's incarnation id. */
    worker: string;
    /** Its stable key. */
    key: string;
    /** The version of the override it applied. */
    seq: number;
    /** Which settings the override replaces, after any refusal. */
    overridden: WorkerConfigKey[];
    /** Why a field was refused, when one was. */
    error?: string;
  };
}

/** One queue event as the socket sends it, discriminated by `type`. */
export type QueueEventWire = {
  [Name in QueueEventName]: {
    /** Envelope version. */
    v: 1;
    /** The queue name. */
    target: string;
    /** When it was emitted, epoch ms. */
    at: number;
    /** Which subsystem emitted it. */
    kind: "queue";
    /** The event name. */
    type: Name;
    /** The job it is about, where it is about one. */
    id?: string;
    /** What it carries. */
    payload: QueueEventPayloadsWire[Name];
  };
}[QueueEventName];

/** One runner event as the socket sends it, discriminated by `type`. */
export type RunnerEventWire = {
  [Name in RunnerEventName]: {
    /** Envelope version. */
    v: 1;
    /** The runner id. */
    target: string;
    /** When it was emitted, epoch ms. */
    at: number;
    /** Which subsystem emitted it. */
    kind: "runner";
    /** The event name. */
    type: Name;
    /** The run it is about, where it is about one. */
    id?: string;
    /** What it carries. */
    payload: RunnerEventPayloadsWire[Name];
  };
}[RunnerEventName];

/**
 * One worker event as the socket sends it, discriminated by `type`.
 *
 * `target` is the queue the worker consumes — worker events are grouped per
 * queue, not per worker — and `id`, where the event is about one worker, its
 * incarnation id, so a transport that indexes on `id` indexes on something
 * meaningful, as it does for jobs and runs.
 */
export type WorkerEventWire = {
  [Name in WorkerEventName]: {
    /** Envelope version. */
    v: 1;
    /** The queue the worker consumes. */
    target: string;
    /** When it was emitted, epoch ms. */
    at: number;
    /** Which subsystem emitted it. */
    kind: "worker";
    /** The event name. */
    type: Name;
    /** The worker it is about, where it is about one. */
    id?: string;
    /** What it carries. */
    payload: WorkerEventPayloadsWire[Name];
  };
}[WorkerEventName];

/**
 * Any event exactly as an `event` frame carries it: discriminate on `kind`,
 * then `type`. `kind` first, because `control` is both a runner event and a
 * worker one.
 */
export type EventWire = QueueEventWire | RunnerEventWire | WorkerEventWire;

/* ------------------------------------------------------------------ *
 * Frames
 * ------------------------------------------------------------------ */

/** Codes an `error` message or an `ack` rejection may carry. */
export type JobsApiWsErrorCode =
  | "VALIDATION"
  | "RATE_LIMITED"
  | "MESSAGE_TOO_LARGE"
  | "UNSUPPORTED_DATA"
  | "INVALID_CHANNEL"
  | "CHANNEL_NOT_AVAILABLE"
  | "QUEUE_NOT_FOUND"
  | "RUNNER_NOT_FOUND"
  | "SUBSCRIPTION_LIMIT"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "EVENTS_UNAVAILABLE"
  | "INTERNAL";

/**
 * Subscribes to channels, optionally resuming after a reconnect.
 *
 * Subscriptions are not reference-counted: subscribing to a channel already
 * held replaces its `events` filter (the last subscribe wins, it does not
 * merge), and one `unsubscribe` removes the channel however many times it was
 * subscribed.
 *
 * With `resume`, replayed events are sent before the `ack`; when they cannot
 * be replayed the `ack` says `resumed: false` and a `gap` follows it. A resume
 * may be split over several frames (different `events` per channel group, or
 * more than 256 channels), each with the same `resume`: each frame's replay
 * covers its own channels, re-sending an event an earlier frame (or live
 * delivery) sent only for other channels. No `(seq, channel)` pair is sent
 * twice on one connection.
 */
export interface JobsApiSubscribeMessage {
  /** The operation. */
  op: "subscribe";
  /** Echoed in the `ack` or `error` that answers it. */
  id: string;
  /**
   * Channels: `all`, `queues`, `queue/<q>`, `queue/<q>/job/<encoded id>`,
   * `runners`, `runner/<r>`. At most `JOBS_API_WS_MAX_CHANNELS_PER_FRAME`
   * (256).
   */
  channels: string[];
  /** Only these event types, for these channels. Absent means every type. Replaces the filter of a channel already held. */
  events?: EventName[];
  /** Replay what was missed since `afterSeq`, when the server still holds it. */
  resume?: {
    /** The `epoch` the client last saw. */
    epoch: string;
    /**
     * The last `seq` the client processed, meaning every event at or below it
     * was received on every channel resumed. Live delivery is in `seq` order,
     * so the highest `seq` seen qualifies — except while a resume is still
     * replaying: a later frame's replay can carry `seq`s below ones an
     * earlier frame's already did, so until every resuming frame is acked,
     * resume again from the position that resume used. One beyond anything
     * the server has stamped in `epoch` is answered as a changed epoch:
     * `resumed: false` and a `gap` from `0`.
     */
    afterSeq: number;
  };
}

/** Unsubscribes from channels. */
export interface JobsApiUnsubscribeMessage {
  /** The operation. */
  op: "unsubscribe";
  /** Echoed in the `ack` or `error` that answers it. */
  id: string;
  /** The channels to leave. */
  channels: string[];
}

/** Asks for a `pong`. */
export interface JobsApiPingMessage {
  /** The operation. */
  op: "ping";
  /** Echoed in the `pong`. */
  id: string;
}

/** Anything a client may send. */
export type JobsApiClientMessage =
  | JobsApiSubscribeMessage
  | JobsApiUnsubscribeMessage
  | JobsApiPingMessage;

/** Sent once, on open. */
export interface JobsApiHelloMessage {
  /** The message type. */
  type: "hello";
  /** The protocol version. */
  protocol: 1;
  /** This connection's id. */
  sessionId: string;
  /** The server instance's epoch: `seq` values are comparable only within one. */
  epoch: string;
  /** The latest `seq` stamped so far. */
  seq: number;
  /** The API's mode, which decides which channels exist. */
  mode: JobsApiMode;
  /** How often a `heartbeat` arrives, in ms; `0` when none do. */
  heartbeatMs: number;
  /** Most channels this connection may hold. */
  maxSubscriptions: number;
  /** How events reach the server: `local` means only this process's events. */
  events: "push" | "poll" | "local";
}

/** One channel an `ack` refused. */
export interface JobsApiAckRejection {
  /** The channel exactly as the client sent it (not canonicalised). */
  channel: string;
  /** Why. */
  code: JobsApiWsErrorCode;
  /** The HTTP-equivalent status. */
  status: number;
  /** A human reason, when there is one. */
  detail?: string;
}

/** Answers a `subscribe` or `unsubscribe`. */
export interface JobsApiAckMessage {
  /** The message type. */
  type: "ack";
  /** The request's `id`. */
  id: string;
  /** Which operation this answers. */
  op: "subscribe" | "unsubscribe";
  /** The channels the operation applied to, in canonical form. */
  channels: string[];
  /** Channels refused, each with its reason. */
  rejected?: JobsApiAckRejection[];
  /**
   * For a `subscribe` with `resume`: `true` when every missed event was
   * replayed for this frame's channels (before this ack), including events an
   * earlier frame or live delivery sent only for other channels; `false` when
   * some could not be, in which case a `gap` covers them — right after this
   * ack, or, if the connection was lagging, when it drains.
   */
  resumed?: boolean;
  /** The latest `seq` stamped when the ack was sent. */
  seq: number;
}

/** One event. */
export interface JobsApiEventMessage {
  /** The message type. */
  type: "event";
  /** Its sequence number within `epoch`. */
  seq: number;
  /** The server instance's epoch. */
  epoch: string;
  /**
   * The channels it is sent for. Live: every subscribed channel it matched,
   * in one frame however many match. In a resume's replay: the resuming
   * frame's channels it matched and had not been sent for yet — so an event
   * can arrive a second time, only for channels it had not reached. No
   * `(seq, channel)` pair repeats: de-duplicate on that pair, not on `seq`.
   */
  subscriptions: string[];
  /** The event. */
  event: EventWire;
}

/** Why events may have been missed. */
export type JobsApiGapReason =
  | "resume-expired"
  | "epoch-changed"
  | "slow-consumer"
  | "coalesced";

/** Events in `[fromSeq, toSeq]` may have been missed: refetch over HTTP. */
export interface JobsApiGapMessage {
  /** The message type. */
  type: "gap";
  /** The server instance's epoch. */
  epoch: string;
  /** The first `seq` that may be missing (`0` when unknown). */
  fromSeq: number;
  /** The last `seq` that may be missing. */
  toSeq: number;
  /** Why. `coalesced` is reserved: progress coalescing announces no gap. */
  reason: JobsApiGapReason;
  /** The channels affected, when not every one. */
  channels?: string[];
}

/** Liveness, every `heartbeatMs`. */
export interface JobsApiHeartbeatMessage {
  /** The message type. */
  type: "heartbeat";
  /**
   * The latest `seq` the server has stamped, across every channel — not only
   * this connection's. `seq` is global, so a jump between heartbeats says
   * nothing about missed events: rely on `gap` frames for that.
   */
  seq: number;
  /** Server time, epoch ms. */
  at: number;
}

/** Answers a `ping`. */
export interface JobsApiPongMessage {
  /** The message type. */
  type: "pong";
  /** The ping's `id`. */
  id: string;
  /** Server time, epoch ms. */
  at: number;
}

/** A failure: a frame that could not be handled, or a limit hit. */
export interface JobsApiErrorMessage {
  /** The message type. */
  type: "error";
  /** The request's `id`, when the failure answers one. */
  id?: string;
  /** Machine code. */
  code: JobsApiWsErrorCode;
  /** The HTTP-equivalent status. */
  status: number;
  /** Human detail. */
  detail: string;
}

/** Anything the server may send. */
export type JobsApiServerMessage =
  | JobsApiHelloMessage
  | JobsApiAckMessage
  | JobsApiEventMessage
  | JobsApiGapMessage
  | JobsApiHeartbeatMessage
  | JobsApiPongMessage
  | JobsApiErrorMessage;
