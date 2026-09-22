import type { BunRequest } from "@kingsleyweb/bun-common";
import type { AsyncApiDocument, ResolvedJobsApiConfig } from "../config";
import type { Schema } from "../schema/builder";
import type { JsonSchema } from "../schema/validate";
import type { ChannelDef } from "../ws/channels";
import type { EventDescriptor } from "../ws/events";
import { MAX_NAME_LENGTH, NAME_PARAM_PATTERN } from "../contract/constants";
import { s, toJsonSchema } from "../schema/builder";
import {
  enabledChannels,
  isWebSocketEnabled,
  MULTI_JOB_EVENTS,
} from "../ws/channels";
import { QUEUE_EVENTS, RUNNER_EVENTS, WORKER_EVENTS } from "../ws/events";
import {
  AckMessageSchema,
  ErrorMessageSchema,
  GapMessageSchema,
  HeartbeatMessageSchema,
  HelloMessageSchema,
  JOBS_API_WS_CLOSE,
  JOBS_API_WS_MAX_CHANNELS_PER_FRAME,
  JOBS_API_WS_SUBPROTOCOL,
  PingMessageSchema,
  PongMessageSchema,
  SubscribeMessageSchema,
  UnsubscribeMessageSchema,
} from "../ws/protocol";
import { RATE_BREACH_WINDOW_MS } from "../ws/session";
import {
  controlMessageExamples,
  eventMessageExamples,
  isControlMessageId,
} from "./asyncapi-examples";
import { pruneSchemaComponents } from "./refs";
import { openApiSecurity, toAsyncApiSecurityScheme } from "./security";

/**
 * The AsyncAPI 3.0 generator for the live-events socket.
 *
 * AsyncAPI 3 describes one channel per address, but this socket multiplexes
 * logical channels (`queue/mail`, `runner/nightly`) over one connection by
 * name. The honest description is therefore two layers: a `connection`
 * channel whose address is the socket's path and which carries the control
 * messages, and one channel per logical family whose "address" is the name a
 * client subscribes with. `info.description` says so.
 *
 * Channels, their messages and the schemas only they use are pruned by the
 * same predicate as routes, so `mode: "jobs"` documents no runner channel,
 * message or schema. With no socket there is no document.
 */

/** The WebSocket bindings version the document declares. */
const WS_BINDING_VERSION = "0.1.0";

/** An event message's payload: the `event` envelope around one event type. */
function eventEnvelope(descriptor: EventDescriptor): Schema<unknown> {
  return s.named(
    `${descriptor.event.ref}Message`,
    s.object(
      {
        type: s.literal("event"),
        seq: s.integer({
          minimum: 1,
          description: "Sequence number within `epoch`.",
        }),
        epoch: s.string({ description: "The server instance's epoch." }),
        subscriptions: s.array(s.string(), {
          minItems: 1,
          description:
            "The channels it is sent for. Live: every subscribed channel it matched, in one frame. In a resume's replay: the resuming subscribe's channels it matched and had not been sent for, so an event can arrive again for channels it had not reached. No (seq, channel) pair repeats: de-duplicate on that pair, not on seq alone.",
        }),
        event: descriptor.event,
      },
      { description: descriptor.summary },
    ),
  );
}

/** Event envelopes, built once: named schemas must keep one identity per name. */
const EVENT_ENVELOPES = new Map<EventDescriptor, Schema<unknown>>(
  [...QUEUE_EVENTS, ...RUNNER_EVENTS, ...WORKER_EVENTS].map((descriptor) => [
    descriptor,
    eventEnvelope(descriptor),
  ]),
);

/** The control messages, by message id. */
const CONTROL_MESSAGES: readonly {
  /** The message id. */
  id: string;
  /** Its payload schema. */
  schema: Schema<unknown>;
  /** One-line summary. */
  summary: string;
}[] = [
  {
    id: "subscribe",
    schema: SubscribeMessageSchema,
    summary: "Subscribe to channels, optionally resuming.",
  },
  {
    id: "unsubscribe",
    schema: UnsubscribeMessageSchema,
    summary: "Leave channels.",
  },
  { id: "ping", schema: PingMessageSchema, summary: "Ask for a pong." },
  {
    id: "hello",
    schema: HelloMessageSchema,
    summary: "Sent once, when the connection opens.",
  },
  {
    id: "ack",
    schema: AckMessageSchema,
    summary:
      "Answers a subscribe or unsubscribe, listing refused channels. Replayed events precede it; a gap may follow it.",
  },
  {
    id: "gap",
    schema: GapMessageSchema,
    summary: "Events may have been missed; refetch over HTTP.",
  },
  {
    id: "heartbeat",
    schema: HeartbeatMessageSchema,
    summary:
      "Liveness, carrying the latest global seq. seq spans every channel, so it cannot detect misses: rely on gap.",
  },
  { id: "pong", schema: PongMessageSchema, summary: "Answers a ping." },
  {
    id: "error",
    schema: ErrorMessageSchema,
    summary: "A frame could not be handled, or a limit was hit.",
  },
];

/**
 * Whether a queue event reaches a job channel: it is about one job (its
 * payload has an `id`) or lists several (`stalled`, `retried`, `cleaned`).
 * Queue-level events — `paused`, `resumed`, `drained`, `repeatScheduled` —
 * never do.
 */
export function reachesJobChannel(descriptor: EventDescriptor): boolean {
  if (descriptor.kind !== "queue") {
    return false;
  }
  if (MULTI_JOB_EVENTS.has(descriptor.type)) {
    return true;
  }
  const properties = (
    descriptor.payload.json as { properties?: Record<string, unknown> }
  ).properties;
  return properties !== undefined && Object.hasOwn(properties, "id");
}

/** The events a channel family carries. */
function eventsOf(def: ChannelDef): readonly EventDescriptor[] {
  if (def.kind === "job") {
    return QUEUE_EVENTS.filter(reachesJobChannel);
  }
  return def.receives === "queue"
    ? QUEUE_EVENTS
    : def.receives === "runner"
      ? RUNNER_EVENTS
      : def.receives === "worker"
        ? WORKER_EVENTS
        : [...QUEUE_EVENTS, ...RUNNER_EVENTS];
}

/** Every close code the server sends, for `x-bun-jobs-close-codes`. */
const CLOSE_CODES: readonly {
  /** The close code. */
  code: number;
  /** Its name in `JOBS_API_WS_CLOSE`. */
  name: keyof typeof JOBS_API_WS_CLOSE;
  /** When it is sent. */
  description: string;
}[] = [
  {
    code: JOBS_API_WS_CLOSE.GOING_AWAY,
    name: "GOING_AWAY",
    description: "The API is closing (`api.close()`). Reconnect and resume.",
  },
  {
    code: JOBS_API_WS_CLOSE.UNSUPPORTED_DATA,
    name: "UNSUPPORTED_DATA",
    description:
      "The client sent a binary frame (an UNSUPPORTED_DATA error precedes it).",
  },
  {
    code: JOBS_API_WS_CLOSE.POLICY,
    name: "POLICY",
    description: `The rate limit was breached a second time within ${RATE_BREACH_WINDOW_MS / 1000} s (the first breach is a RATE_LIMITED error).`,
  },
  {
    code: JOBS_API_WS_CLOSE.TOO_BIG,
    name: "TOO_BIG",
    description:
      "The client sent a frame over `maxMessageBytes` (a MESSAGE_TOO_LARGE error precedes it).",
  },
  {
    code: JOBS_API_WS_CLOSE.SLOW_CONSUMER,
    name: "SLOW_CONSUMER",
    description:
      "The client stayed behind for `slowConsumerTimeoutMs`. Reconnect and resume.",
  },
  {
    code: JOBS_API_WS_CLOSE.UNAUTHORIZED,
    name: "UNAUTHORIZED",
    description:
      "Reserved: the session is no longer authorized. Not sent in protocol 1.",
  },
];

/**
 * How an upgrade is refused, before any socket exists, for
 * `x-bun-jobs-upgrade-refusals`: an ordinary HTTP response whose body is an
 * RFC 9457 problem (`application/problem+json`) carrying `code`.
 */
const UPGRADE_REFUSALS: readonly {
  /** The HTTP status. */
  status: number;
  /** The problem's `code`. */
  code: string;
  /** When it is sent. */
  description: string;
  /** Response headers it carries. */
  headers?: Record<string, string>;
}[] = [
  {
    status: 400,
    code: "UNSUPPORTED_SUBPROTOCOL",
    description: `Sec-WebSocket-Protocol was sent without \`${JOBS_API_WS_SUBPROTOCOL}\`. Offer it, or no subprotocol.`,
  },
  {
    status: 403,
    code: "ORIGIN_REJECTED",
    description: "The Origin header is not an allowed origin.",
  },
  {
    status: 429,
    code: "CONNECTION_LIMIT",
    description: "`maxConnections` live-event connections are already open.",
    headers: { "Retry-After": "1" },
  },
  {
    status: 401,
    code: "UNAUTHORIZED",
    description: "`authorize` asked for authentication (`events.connect`).",
  },
  {
    status: 403,
    code: "FORBIDDEN",
    description: "`authorize` refused the connection (`events.connect`).",
  },
  {
    status: 404,
    code: "ROUTE_NOT_FOUND",
    description: "The API has been closed.",
  },
];

/** Descriptions of address parameters. */
const PARAMETER_DESCRIPTIONS: Record<ChannelDef["parameters"][number], string> =
  {
    queue: `A queue name, matching \`${NAME_PARAM_PATTERN}\` (at most ${MAX_NAME_LENGTH} characters).`,
    jobId:
      "A job id, escaped with `encodeJobId` (exported by `@kingsleyweb/bun-jobs/api/contract`): `encodeURIComponent`, except that a lone UTF-16 surrogate, which `encodeURIComponent` refuses, becomes `%uXXXX` (upper-case hex). `decodeJobId` reverses either form; the two cannot be confused, since `encodeURIComponent` escapes every `%`.",
    runner: `A runner id, matching \`${NAME_PARAM_PATTERN}\` (at most ${MAX_NAME_LENGTH} characters).`,
  };

/** The JSON Schema a queue name or runner id matches: the one the HTTP routes enforce. */
const NAME_PARAMETER_SCHEMA = {
  type: "string",
  pattern: NAME_PARAM_PATTERN,
  maxLength: MAX_NAME_LENGTH,
} as const;

/**
 * Each address parameter's value schema, where it has one, emitted as the
 * extension `x-bun-jobs-schema`. AsyncAPI 3.0's Parameter Object has no
 * `schema` field (it was removed in 3.0, and the official JSON Schema forbids
 * unknown fields there), so the schema the OpenAPI path parameters carry
 * natively travels as an extension instead. A job id has none: it is escaped
 * with `encodeJobId`, so any string escapes to a valid segment.
 */
const PARAMETER_SCHEMAS: Partial<
  Record<ChannelDef["parameters"][number], typeof NAME_PARAMETER_SCHEMA>
> = {
  queue: NAME_PARAMETER_SCHEMA,
  runner: NAME_PARAMETER_SCHEMA,
};

/** One address parameter, as the document describes it. */
function parameterObject(
  name: ChannelDef["parameters"][number],
): Record<string, unknown> {
  const schema = PARAMETER_SCHEMAS[name];
  return {
    description: PARAMETER_DESCRIPTIONS[name],
    ...(schema ? { "x-bun-jobs-schema": { ...schema } } : {}),
  };
}

/** `queue` → `Queue`, `runners` → `Runners`. */
function pascal(name: string): string {
  return `${name[0]!.toUpperCase()}${name.slice(1)}`;
}

/** Where the socket is served, for the document's `servers`. */
export interface AsyncApiSocketInfo {
  /** The socket's full path. */
  path: string;
  /** The dedicated server's port, when there is one. */
  port: number | undefined;
}

/**
 * Generates the AsyncAPI 3.0 document, or `undefined` when the configuration
 * has no socket. The server `host` is a `{host}` variable (defaulting to
 * `localhost`, plus the dedicated port) unless `docs.asyncapiServer` fixes
 * it; {@link asyncApiForRequest} fills it in from a docs request.
 */
export function generateAsyncApi(
  config: ResolvedJobsApiConfig,
  socket: AsyncApiSocketInfo,
): AsyncApiDocument | undefined {
  if (!isWebSocketEnabled(config)) {
    return undefined;
  }
  const docs = config.docs === false ? undefined : config.docs;
  const websocket = config.websocket as Exclude<
    ResolvedJobsApiConfig["websocket"],
    false
  >;
  const components = new Map<string, JsonSchema>();
  const emit = (schema: Schema<unknown>) =>
    toJsonSchema(schema, { components });

  // Security: the OpenAPI declarations, validated there, mapped here.
  const security = openApiSecurity(config.docs);
  const securitySchemes: Record<string, Record<string, unknown>> = {};
  const notes: string[] = [];
  if (security.securitySchemes) {
    const referenced = new Set(
      (security.security ?? []).flatMap((requirement) =>
        Object.keys(requirement),
      ),
    );
    for (const [name, scheme] of Object.entries(security.securitySchemes)) {
      if (!referenced.has(name)) {
        continue;
      }
      const mapped = toAsyncApiSecurityScheme(scheme);
      securitySchemes[name] = {
        ...mapped.scheme,
        ...(mapped.browserNote
          ? { "x-bun-jobs-note": mapped.browserNote }
          : {}),
      };
      if (mapped.browserNote) {
        notes.push(`\`${name}\`: ${mapped.browserNote}`);
      }
    }
  }
  const hasSecurity = Object.keys(securitySchemes).length > 0;

  // AsyncAPI 3's `server.security` is a list of alternatives, each ONE scheme
  // (with the scopes it needs in `scopes`); it has no way to say "these two
  // together". So a requirement naming one scheme maps natively — a `$ref`,
  // or an inline copy carrying `scopes` when it needs some — while one naming
  // several (an AND) is left out of the native list rather than split into
  // alternatives that would each claim to suffice alone. The requirements are
  // kept whole, with OpenAPI's meaning, in `x-bun-jobs-security`.
  const requirements = security.security ?? [];
  const nativeSecurity: Record<string, unknown>[] = [];
  let conjunctive = false;
  for (const requirement of requirements) {
    const names = Object.keys(requirement);
    if (names.length !== 1) {
      conjunctive ||= names.length > 1;
      continue;
    }
    const name = names[0]!;
    const scopes = requirement[name] ?? [];
    nativeSecurity.push(
      scopes.length === 0
        ? { $ref: `#/components/securitySchemes/${name}` }
        : { ...securitySchemes[name], scopes: [...scopes] },
    );
  }
  if (conjunctive) {
    notes.push(
      "`servers.api.security` lists only the requirements AsyncAPI 3 can express — one scheme each; `x-bun-jobs-security` holds every requirement, with OpenAPI's meaning: any one object suffices, and every scheme within one object is required together, with its listed scopes.",
    );
  }

  // Messages: the control messages, then one per event type the enabled
  // channels carry.
  const channelsEnabled = enabledChannels(config);
  const messages: Record<string, Record<string, unknown>> = {};
  for (const control of CONTROL_MESSAGES) {
    messages[control.id] = {
      name: control.id,
      title: pascal(control.id),
      summary: control.summary,
      contentType: "application/json",
      payload: emit(control.schema),
      ...(isControlMessageId(control.id)
        ? { examples: controlMessageExamples(control.id) }
        : {}),
    };
  }
  const carried = new Set<EventDescriptor>(
    channelsEnabled.flatMap((def) => [...eventsOf(def)]),
  );
  for (const descriptor of [
    ...QUEUE_EVENTS,
    ...RUNNER_EVENTS,
    ...WORKER_EVENTS,
  ]) {
    if (!carried.has(descriptor)) {
      continue;
    }
    messages[descriptor.messageName] = {
      name: descriptor.messageName,
      title: `${pascal(descriptor.kind)} ${descriptor.type}`,
      summary: descriptor.summary,
      contentType: "application/json",
      payload: emit(EVENT_ENVELOPES.get(descriptor)!),
      examples: eventMessageExamples(descriptor),
    };
  }

  const messageRef = (id: string) => ({ $ref: `#/components/messages/${id}` });
  const channelRef = (id: string) => ({ $ref: `#/channels/${id}` });
  const channelMessageRef = (channel: string, id: string) => ({
    $ref: `#/channels/${channel}/messages/${id}`,
  });

  const channels: Record<string, Record<string, unknown>> = {
    connection: {
      address: socket.path,
      title: "Connection",
      description: [
        `The WebSocket itself (subprotocol \`${JOBS_API_WS_SUBPROTOCOL}\`, optional). Control messages travel here; events for the logical channels below arrive over it once subscribed.`,
        "Ordering: live events arrive in `seq` order. A subscribe with `resume` sends the replayed events first, then the `ack`; when events could not be replayed the ack says `resumed: false` and a `gap` follows it. A resume split over several subscribes replays each one's channels in full, so a later one can replay `seq`s below ones already received: resume again from the same position until every resuming subscribe is acked. A connection that falls behind stops receiving events and, once it catches up, receives one `gap` (`slow-consumer`) covering what it skipped. A connection subscribed to `workers` receives one `gap` (`queue-discovered`, `channels: [\"workers\"]`) when the server's discovery pass finds queues another process created: what their workers published before the pass was missed.",
        "Subscriptions are not reference-counted: subscribing to a channel already held replaces its `events` filter (the last subscribe wins), and one unsubscribe removes it.",
        "An upgrade can be refused before any socket exists, with an ordinary HTTP problem response (`x-bun-jobs-upgrade-refusals`); an open connection is closed with the codes in `x-bun-jobs-close-codes`; the limits it is held to are in `x-bun-jobs-limits`.",
      ].join("\n\n"),
      messages: Object.fromEntries(
        CONTROL_MESSAGES.map((control) => [control.id, messageRef(control.id)]),
      ),
      bindings: { ws: { method: "GET", bindingVersion: WS_BINDING_VERSION } },
      "x-bun-jobs-subprotocol": JOBS_API_WS_SUBPROTOCOL,
      "x-bun-jobs-close-codes": CLOSE_CODES.map((entry) => ({ ...entry })),
      "x-bun-jobs-limits": {
        maxMessageBytes: websocket.maxMessageBytes,
        messagesPerSecond: websocket.messagesPerSecond,
        rateLimitBurst: websocket.messagesPerSecond * 2,
        rateLimitBreachWindowMs: RATE_BREACH_WINDOW_MS,
        maxSubscriptions: websocket.maxSubscriptions,
        maxChannelsPerFrame: JOBS_API_WS_MAX_CHANNELS_PER_FRAME,
        maxConnections: websocket.maxConnections,
        heartbeatMs: websocket.heartbeatMs,
        maxBufferedBytes: websocket.maxBufferedBytes,
        slowConsumerTimeoutMs: websocket.slowConsumerTimeoutMs,
        coalesceProgressMs: websocket.coalesceProgressMs,
        replay: websocket.replay === false ? false : { ...websocket.replay },
      },
      "x-bun-jobs-upgrade-refusals": UPGRADE_REFUSALS.map((entry) => ({
        ...entry,
        contentType: "application/problem+json",
        ...(entry.headers ? { headers: { ...entry.headers } } : {}),
      })),
    },
  };
  const operations: Record<string, Record<string, unknown>> = {
    subscribe: {
      action: "send",
      channel: channelRef("connection"),
      title: "Subscribe",
      summary: "Subscribe to channels; each is authorized separately.",
      messages: [channelMessageRef("connection", "subscribe")],
      reply: {
        channel: channelRef("connection"),
        messages: [
          channelMessageRef("connection", "ack"),
          channelMessageRef("connection", "error"),
        ],
      },
      "x-bun-jobs-action": "events.subscribe",
    },
    unsubscribe: {
      action: "send",
      channel: channelRef("connection"),
      title: "Unsubscribe",
      summary: "Leave channels.",
      messages: [channelMessageRef("connection", "unsubscribe")],
      reply: {
        channel: channelRef("connection"),
        messages: [
          channelMessageRef("connection", "ack"),
          channelMessageRef("connection", "error"),
        ],
      },
      "x-bun-jobs-action": "events.subscribe",
    },
    ping: {
      action: "send",
      channel: channelRef("connection"),
      title: "Ping",
      summary: "Ask for a pong.",
      messages: [channelMessageRef("connection", "ping")],
      reply: {
        channel: channelRef("connection"),
        messages: [channelMessageRef("connection", "pong")],
      },
      "x-bun-jobs-action": "events.connect",
    },
    receiveControl: {
      action: "receive",
      channel: channelRef("connection"),
      title: "Receive control messages",
      summary: "Greeting, gaps, heartbeats and errors.",
      messages: ["hello", "gap", "heartbeat", "error"].map((id) =>
        channelMessageRef("connection", id),
      ),
      "x-bun-jobs-action": "events.connect",
    },
  };

  for (const def of channelsEnabled) {
    const events = eventsOf(def);
    const label = def.label ?? pascal(def.kind);
    channels[def.kind] = {
      address: def.address,
      title: label,
      description: `${def.description} A logical channel: subscribe with its name over the connection.`,
      ...(def.parameters.length > 0
        ? {
            parameters: Object.fromEntries(
              def.parameters.map((name) => [name, parameterObject(name)]),
            ),
          }
        : {}),
      messages: Object.fromEntries(
        events.map((event) => [
          event.messageName,
          messageRef(event.messageName),
        ]),
      ),
    };
    operations[`receive${pascal(def.kind)}Events`] = {
      action: "receive",
      channel: channelRef(def.kind),
      title: `Receive ${label[0]!.toLowerCase()}${label.slice(1)} events`,
      summary: def.description,
      messages: events.map((event) =>
        channelMessageRef(def.kind, event.messageName),
      ),
      "x-bun-jobs-action": "events.subscribe",
    };
  }

  const fixed = docs?.asyncapiServer;
  const defaultHost = `localhost${socket.port === undefined ? "" : `:${socket.port}`}`;
  const server: Record<string, unknown> = {
    host: fixed ? fixed.host : "{host}",
    pathname: socket.path,
    protocol: fixed ? fixed.protocol : "ws",
    description:
      socket.port === undefined
        ? "The host application's server."
        : "The socket's dedicated server.",
    ...(fixed
      ? {}
      : {
          variables: {
            host: {
              default: defaultHost,
              description:
                "The host (and port) the socket is served on. The document served over HTTP fills in the request's own.",
            },
          },
        }),
    "x-bun-jobs-subprotocol": JOBS_API_WS_SUBPROTOCOL,
    ...(nativeSecurity.length > 0 ? { security: nativeSecurity } : {}),
    ...(hasSecurity
      ? { "x-bun-jobs-security": structuredClone(requirements) }
      : {}),
  };

  const description =
    docs?.description ??
    [
      "Live events for bun-jobs queues and runners, over one WebSocket.",
      "Connect to the server, then `subscribe` by channel name: the channels other than `connection` have no transport address of their own and are multiplexed over the connection. Every event carries a `seq` within an `epoch`; resume after a reconnect with `resume`, and treat a `gap` as a reason to refetch.",
      "Events are invalidation hints, not a log: the notifier hears only what producers publish, and HTTP stays the source of truth.",
      hasSecurity
        ? ""
        : "Authorization is enforced by the host application's `authorize` hook, on the upgrade and on each subscription; this document declares no security schemes.",
      ...notes.map((note) => `Note — ${note}`),
    ]
      .filter((line) => line !== "")
      .join("\n\n");

  const document: AsyncApiDocument = {
    asyncapi: "3.0.0",
    info: {
      title: docs?.title ?? `bun-jobs management API (${config.namespace})`,
      version: docs?.version ?? packageVersion(),
      description,
    },
    defaultContentType: "application/json",
    servers: { api: server },
    channels,
    operations,
    components: {
      schemas: Object.fromEntries(
        [...components].sort(([a], [b]) => a.localeCompare(b)),
      ),
      messages,
      ...(hasSecurity ? { securitySchemes } : {}),
    },
  };
  pruneSchemaComponents(
    document as unknown as Parameters<typeof pruneSchemaComponents>[0],
  );
  return document;
}

/** Per-request document sources, by resolved configuration. */
const SOURCES = new WeakMap<
  ResolvedJobsApiConfig,
  (req: BunRequest) => AsyncApiDocument
>();

/**
 * Records where the AsyncAPI document for an API comes from, so the docs route
 * — which sees only the resolved configuration — can serve it.
 */
export function registerAsyncApiSource(
  config: ResolvedJobsApiConfig,
  source: (req: BunRequest) => AsyncApiDocument,
): void {
  SOURCES.set(config, source);
}

/** The AsyncAPI document for a docs request, or `undefined` when the API has no socket. */
export function asyncApiDocumentFor(
  config: ResolvedJobsApiConfig,
  req: BunRequest,
): AsyncApiDocument | undefined {
  return SOURCES.get(config)?.(req);
}

/** The bun-jobs package version, the default `info.version`. */
function packageVersion(): string {
  return (import.meta.require("../../../package.json") as { version: string })
    .version;
}

/**
 * A copy of `document` whose server names the host a docs request was sent
 * to: the request's `Host` (with the dedicated port instead, when there is
 * one), and `wss` for a secure request. A document whose server was fixed by
 * `docs.asyncapiServer` is returned as a copy, unchanged.
 */
export function asyncApiForRequest(
  document: AsyncApiDocument,
  req: BunRequest,
  socket: AsyncApiSocketInfo,
): AsyncApiDocument {
  const copy = structuredClone(document);
  const server = (copy.servers as Record<string, Record<string, unknown>>).api!;
  if (server.variables === undefined) {
    return copy;
  }
  const host =
    socket.port === undefined
      ? req.getHeader("host") || req.host
      : `${req.hostname}:${socket.port}`;
  if (host) {
    server.host = host;
    delete server.variables;
  }
  server.protocol = req.secure ? "wss" : "ws";
  return copy;
}
