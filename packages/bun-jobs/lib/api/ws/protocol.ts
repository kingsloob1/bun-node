import type { JobsApiMode } from "../config";
import type { Infer } from "../schema/builder";
import type { EventDto } from "../serialize";
import type { Equivalent } from "./events";
import { s } from "../schema/builder";
import { EVENT_TYPES, EventDtoSchema } from "./events";

/**
 * The socket's wire protocol: every frame either side may send, as schemas
 * (validated with the same validator as HTTP bodies, and emitted into the
 * AsyncAPI document) and as types (for clients, which import them type-only).
 *
 * Every frame is a JSON text frame. A client sends `op` messages; the server
 * sends `type` messages.
 */

/** The WebSocket subprotocol. A client offering subprotocols must offer this one. */
export const JOBS_API_WS_SUBPROTOCOL = "bun-jobs.v1";

/** Close codes the server uses. */
export const JOBS_API_WS_CLOSE = {
  /** A normal close. */
  NORMAL: 1000,
  /** The API is closing (`api.close()`). */
  GOING_AWAY: 1001,
  /** The client sent a binary frame. */
  UNSUPPORTED_DATA: 1003,
  /** The client broke a policy: rate limit breached twice within 10 s. */
  POLICY: 1008,
  /** The client sent a frame over `maxMessageBytes`. */
  TOO_BIG: 1009,
  /** The client could not keep up for `slowConsumerTimeoutMs`. */
  SLOW_CONSUMER: 4008,
  /** Reserved: the session is no longer authorized. Not sent in protocol 1. */
  UNAUTHORIZED: 4401,
} as const;

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

/* ------------------------------------------------------------------ *
 * Client → server
 * ------------------------------------------------------------------ */

/** Subscribes to channels, optionally resuming after a reconnect. */
export interface JobsApiSubscribeMessage {
  /** The operation. */
  op: "subscribe";
  /** Echoed in the `ack` or `error` that answers it. */
  id: string;
  /** Channels: `all`, `queues`, `queue/<q>`, `queue/<q>/job/<encoded id>`, `runners`, `runner/<r>`. */
  channels: string[];
  /** Only these event types, for these channels. Absent means every type. */
  events?: (typeof EVENT_TYPES)[number][];
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

/* ------------------------------------------------------------------ *
 * Server → client
 * ------------------------------------------------------------------ */

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
  /** The channel, as the client sent it. */
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
  /** For a `subscribe` with `resume`: whether missed events were replayed. */
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
  /** Every subscribed channel it matched: an event is sent once, however many match. */
  subscriptions: string[];
  /** The event. */
  event: EventDto;
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
  /** The latest `seq` stamped: a jump beyond what arrived means events were missed. */
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

/* ------------------------------------------------------------------ *
 * Schemas
 * ------------------------------------------------------------------ */

/** A request id. */
const MessageIdSchema = s.string({
  minLength: 1,
  maxLength: 128,
  description: "Chosen by the client; echoed in the reply.",
});

/** A channel name. */
const ChannelSchema = s.string({
  minLength: 1,
  maxLength: 1024,
  description:
    "`all`, `queues`, `queue/<queue>`, `queue/<queue>/job/<encodeURIComponent(jobId)>`, `runners` or `runner/<runner>`.",
});

/** Channel lists. */
const ChannelListSchema = s.array(ChannelSchema, {
  minItems: 1,
  maxItems: 1000,
});

/** A sequence number. */
const SeqSchema = s.integer({ minimum: 0 });

/** An epoch-ms instant. */
const AtSchema = s.integer({ description: "Server time, epoch ms." });

/** `subscribe`. */
export const SubscribeMessageSchema = s.named(
  "SubscribeMessage",
  s.object(
    {
      op: s.literal("subscribe"),
      id: MessageIdSchema,
      channels: ChannelListSchema,
      events: s.optional(s.array(s.enum(EVENT_TYPES), { minItems: 1 })),
      resume: s.optional(
        s.object({
          epoch: s.string({ minLength: 1, maxLength: 128 }),
          afterSeq: SeqSchema,
        }),
      ),
    },
    {
      description:
        "Subscribes to channels. Each channel is authorized separately (`events.subscribe`); refusals are listed in the ack without closing the socket.",
    },
  ),
);

/** `unsubscribe`. */
export const UnsubscribeMessageSchema = s.named(
  "UnsubscribeMessage",
  s.object({
    op: s.literal("unsubscribe"),
    id: MessageIdSchema,
    channels: ChannelListSchema,
  }),
);

/** `ping`. */
export const PingMessageSchema = s.named(
  "PingMessage",
  s.object({ op: s.literal("ping"), id: MessageIdSchema }),
);

/** Any client frame. */
export const ClientMessageSchema = s.union(
  SubscribeMessageSchema,
  UnsubscribeMessageSchema,
  PingMessageSchema,
);

/** `hello`. */
export const HelloMessageSchema = s.named(
  "HelloMessage",
  s.object({
    type: s.literal("hello"),
    protocol: s.literal(1),
    sessionId: s.string(),
    epoch: s.string(),
    seq: SeqSchema,
    mode: s.enum(["jobs", "runner", "both"]),
    heartbeatMs: s.integer({ minimum: 0 }),
    maxSubscriptions: s.integer({ minimum: 1 }),
    events: s.enum(["push", "poll", "local"]),
  }),
);

/** `ack`. */
export const AckMessageSchema = s.named(
  "AckMessage",
  s.object({
    type: s.literal("ack"),
    id: s.string(),
    op: s.enum(["subscribe", "unsubscribe"]),
    channels: s.array(s.string()),
    rejected: s.optional(
      s.array(
        s.object({
          channel: s.string(),
          code: s.enum([
            "VALIDATION",
            "RATE_LIMITED",
            "MESSAGE_TOO_LARGE",
            "UNSUPPORTED_DATA",
            "INVALID_CHANNEL",
            "CHANNEL_NOT_AVAILABLE",
            "QUEUE_NOT_FOUND",
            "RUNNER_NOT_FOUND",
            "SUBSCRIPTION_LIMIT",
            "UNAUTHORIZED",
            "FORBIDDEN",
            "EVENTS_UNAVAILABLE",
            "INTERNAL",
          ]),
          status: s.integer({ minimum: 100, maximum: 599 }),
          detail: s.optional(s.string()),
        }),
      ),
    ),
    resumed: s.optional(s.boolean()),
    seq: SeqSchema,
  }),
);

/** `event`, for any event. The AsyncAPI document has one message per event type. */
export const EventMessageSchema = s.named(
  "EventMessage",
  s.object({
    type: s.literal("event"),
    seq: s.integer({ minimum: 1 }),
    epoch: s.string(),
    subscriptions: s.array(s.string(), { minItems: 1 }),
    event: EventDtoSchema,
  }),
);

/** `gap`. */
export const GapMessageSchema = s.named(
  "GapMessage",
  s.object(
    {
      type: s.literal("gap"),
      epoch: s.string(),
      fromSeq: SeqSchema,
      toSeq: SeqSchema,
      reason: s.enum([
        "resume-expired",
        "epoch-changed",
        "slow-consumer",
        "coalesced",
      ]),
      channels: s.optional(s.array(s.string())),
    },
    {
      description:
        "Events in [fromSeq, toSeq] may have been missed; refetch the affected resources over HTTP.",
    },
  ),
);

/** `heartbeat`. */
export const HeartbeatMessageSchema = s.named(
  "HeartbeatMessage",
  s.object({ type: s.literal("heartbeat"), seq: SeqSchema, at: AtSchema }),
);

/** `pong`. */
export const PongMessageSchema = s.named(
  "PongMessage",
  s.object({ type: s.literal("pong"), id: s.string(), at: AtSchema }),
);

/** `error`. */
export const ErrorMessageSchema = s.named(
  "ErrorMessage",
  s.object({
    type: s.literal("error"),
    id: s.optional(s.string()),
    code: s.enum([
      "VALIDATION",
      "RATE_LIMITED",
      "MESSAGE_TOO_LARGE",
      "UNSUPPORTED_DATA",
      "INVALID_CHANNEL",
      "CHANNEL_NOT_AVAILABLE",
      "QUEUE_NOT_FOUND",
      "RUNNER_NOT_FOUND",
      "SUBSCRIPTION_LIMIT",
      "UNAUTHORIZED",
      "FORBIDDEN",
      "EVENTS_UNAVAILABLE",
      "INTERNAL",
    ]),
    status: s.integer({ minimum: 100, maximum: 599 }),
    detail: s.string(),
  }),
);

/** Any server frame. */
export const ServerMessageSchema = s.union(
  HelloMessageSchema,
  AckMessageSchema,
  EventMessageSchema,
  GapMessageSchema,
  HeartbeatMessageSchema,
  PongMessageSchema,
  ErrorMessageSchema,
);

/** Message schemas whose inferred type differs from the declared interface. */
type ProtocolMismatch =
  | (Equivalent<
      Infer<typeof SubscribeMessageSchema>,
      JobsApiSubscribeMessage
    > extends true
      ? never
      : "subscribe")
  | (Equivalent<
      Infer<typeof UnsubscribeMessageSchema>,
      JobsApiUnsubscribeMessage
    > extends true
      ? never
      : "unsubscribe")
  | (Equivalent<
      Infer<typeof PingMessageSchema>,
      JobsApiPingMessage
    > extends true
      ? never
      : "ping")
  | (Equivalent<
      Infer<typeof HelloMessageSchema>,
      JobsApiHelloMessage
    > extends true
      ? never
      : "hello")
  | (Equivalent<Infer<typeof AckMessageSchema>, JobsApiAckMessage> extends true
      ? never
      : "ack")
  | (Equivalent<Infer<typeof GapMessageSchema>, JobsApiGapMessage> extends true
      ? never
      : "gap")
  | (Equivalent<
      Infer<typeof HeartbeatMessageSchema>,
      JobsApiHeartbeatMessage
    > extends true
      ? never
      : "heartbeat")
  | (Equivalent<
      Infer<typeof PongMessageSchema>,
      JobsApiPongMessage
    > extends true
      ? never
      : "pong")
  | (Equivalent<
      Infer<typeof ErrorMessageSchema>,
      JobsApiErrorMessage
    > extends true
      ? never
      : "error");

/**
 * Compile-time guard that each schema and its interface agree, so the types a
 * client imports describe exactly what the validator and the AsyncAPI
 * document accept. (`event` is checked per event type in `events.ts`.)
 */
const _protocolTypesMatch: [ProtocolMismatch] extends [never]
  ? true
  : ProtocolMismatch = true;
