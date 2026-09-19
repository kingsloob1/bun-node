import type {
  JobsApiAckMessage,
  JobsApiErrorMessage,
  JobsApiGapMessage,
  JobsApiHeartbeatMessage,
  JobsApiHelloMessage,
  JobsApiPingMessage,
  JobsApiPongMessage,
  JobsApiSubscribeMessage,
  JobsApiUnsubscribeMessage,
} from "../contract/ws";
import type { Infer } from "../schema/builder";
import type { Equivalent } from "./events";
import { JOBS_API_WS_MAX_CHANNELS_PER_FRAME } from "../contract/constants";
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

/** The WebSocket subprotocol and the server's close codes: defined in the browser-safe contract. */
export {
  JOBS_API_WS_CLOSE,
  JOBS_API_WS_SUBPROTOCOL,
} from "../contract/constants";

/**
 * The frame types themselves are defined once, in the browser-safe contract
 * (`contract/ws.ts`), and re-exported here: the server builds and parses
 * exactly the types a client imports, so the two cannot disagree. The
 * schemas below are held to them by the compile-time check at the end.
 */
export type {
  JobsApiAckMessage,
  JobsApiAckRejection,
  JobsApiClientMessage,
  JobsApiErrorMessage,
  JobsApiEventMessage,
  JobsApiGapMessage,
  JobsApiGapReason,
  JobsApiHeartbeatMessage,
  JobsApiHelloMessage,
  JobsApiPingMessage,
  JobsApiPongMessage,
  JobsApiServerMessage,
  JobsApiSubscribeMessage,
  JobsApiUnsubscribeMessage,
  JobsApiWsErrorCode,
} from "../contract/ws";

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
    "`all`, `queues`, `queue/<queue>`, `queue/<queue>/job/<encodeJobId(jobId)>`, `runners` or `runner/<runner>`. `encodeJobId` (in the contract) is `encodeURIComponent`, plus `%uXXXX` for a lone surrogate.",
});

/** Most channels one `subscribe` or `unsubscribe` may name: defined in the browser-safe contract. */
export { JOBS_API_WS_MAX_CHANNELS_PER_FRAME };

/**
 * Channel lists. At most 256 per frame: well above the default of 50
 * subscriptions a connection may hold, and small enough that one frame's
 * parsing stays cheap. Authorization is bounded separately, by the free slots.
 */
const ChannelListSchema = s.array(ChannelSchema, {
  minItems: 1,
  maxItems: JOBS_API_WS_MAX_CHANNELS_PER_FRAME,
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
        "Subscribes to channels. Each channel is authorized separately (`events.subscribe`); refusals are listed in the ack without closing the socket. Only as many channels not already held as the connection has free slots are authorized; the rest are refused SUBSCRIPTION_LIMIT. Subscriptions are not reference-counted: subscribing to a channel already held replaces its `events` filter (the last subscribe wins), and one unsubscribe removes it. With `resume`, replayed events arrive before the ack; if they cannot be replayed the ack says `resumed: false` and a gap follows it. A resume split over several frames replays each frame's channels in full: an event an earlier frame (or live delivery) sent only for other channels is sent again, listing just this frame's channels it had not reached. No (seq, channel) pair is sent twice on one connection.",
    },
  ),
);

/** `unsubscribe`. */
export const UnsubscribeMessageSchema = s.named(
  "UnsubscribeMessage",
  s.object(
    {
      op: s.literal("unsubscribe"),
      id: MessageIdSchema,
      channels: ChannelListSchema,
    },
    {
      description:
        "Leaves channels. One unsubscribe removes a channel however many times it was subscribed; leaving a channel not held is not an error.",
    },
  ),
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
          channel: s.string({
            description:
              "The channel exactly as the client sent it (not canonicalised).",
          }),
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
  s.object(
    {
      type: s.literal("heartbeat"),
      seq: s.integer({
        minimum: 0,
        description:
          "The latest seq stamped, across every channel. seq is global, so a jump says nothing about missed events; rely on gap frames.",
      }),
      at: AtSchema,
    },
    { description: "Liveness. Not sent while the connection is lagging." },
  ),
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
