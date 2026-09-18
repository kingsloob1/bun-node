import type {
  EventName,
  JobsApiMode,
  JobState,
  QueueEventName,
  RunnerEventName,
} from "./constants";

/**
 * The live-events socket's wire protocol as named types: every frame a client
 * sends and every frame the server sends, and every event an `event` frame
 * carries.
 *
 * **Browser-safe**: imports only its sibling `constants.ts`, type-only.
 * **Cannot drift**: `__tests__/api/api-contract.type-test.ts` asserts each
 * type equals the server's own (`lib/api/ws/protocol.ts`, `ws/events.ts`).
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
  progress: { id: string; progress: unknown };
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
  /** A controller changed the runner's state or queued a trigger. */
  control: { action: "pause" | "resume" | "schedule" | "trigger" };
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

/** Any event exactly as an `event` frame carries it: discriminate on `kind`, then `type`. */
export type EventWire = QueueEventWire | RunnerEventWire;

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

/** Subscribes to channels, optionally resuming after a reconnect. The last subscribe to a channel sets its filter. */
export interface JobsApiSubscribeMessage {
  /** The operation. */
  op: "subscribe";
  /** Echoed in the `ack` or `error` that answers it. */
  id: string;
  /** Channels, at most `JOBS_API_WS_MAX_CHANNELS_PER_FRAME`. */
  channels: string[];
  /** Only these event types, for these channels. Absent means every type. */
  events?: EventName[];
  /** Replay what was missed since `afterSeq`, when the server still holds it. */
  resume?: {
    /** The `epoch` the client last saw. */
    epoch: string;
    /** The last `seq` the client processed. */
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
  /** The channel exactly as the client sent it. */
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
  /** For a `subscribe` with `resume`: whether every missed event was replayed. */
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
  /** Every subscribed channel it matched. */
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
  /** Why. */
  reason: JobsApiGapReason;
  /** The channels affected, when not every one. */
  channels?: string[];
}

/** Liveness, every `heartbeatMs`. */
export interface JobsApiHeartbeatMessage {
  /** The message type. */
  type: "heartbeat";
  /** The latest `seq` the server has stamped, across every channel. */
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
