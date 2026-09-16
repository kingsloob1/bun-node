import type { BunRequest } from "@kingsleyweb/bun-common";
import type { AsyncApiDocument, ResolvedJobsApiConfig } from "../config";
import type { Schema } from "../schema/builder";
import type { JsonSchema } from "../schema/validate";
import type { ChannelDef } from "../ws/channels";
import type { EventDescriptor } from "../ws/events";
import { s, toJsonSchema } from "../schema/builder";
import { enabledChannels, isWebSocketEnabled } from "../ws/channels";
import { QUEUE_EVENTS, RUNNER_EVENTS } from "../ws/events";
import {
  AckMessageSchema,
  ErrorMessageSchema,
  GapMessageSchema,
  HeartbeatMessageSchema,
  HelloMessageSchema,
  JOBS_API_WS_SUBPROTOCOL,
  PingMessageSchema,
  PongMessageSchema,
  SubscribeMessageSchema,
  UnsubscribeMessageSchema,
} from "../ws/protocol";
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
            "Every subscribed channel the event matched; it is sent once.",
        }),
        event: descriptor.event,
      },
      { description: descriptor.summary },
    ),
  );
}

/** Event envelopes, built once: named schemas must keep one identity per name. */
const EVENT_ENVELOPES = new Map<EventDescriptor, Schema<unknown>>(
  [...QUEUE_EVENTS, ...RUNNER_EVENTS].map((descriptor) => [
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
    summary: "Answers a subscribe or unsubscribe, listing refused channels.",
  },
  {
    id: "gap",
    schema: GapMessageSchema,
    summary: "Events may have been missed; refetch over HTTP.",
  },
  {
    id: "heartbeat",
    schema: HeartbeatMessageSchema,
    summary: "Liveness, carrying the latest seq.",
  },
  { id: "pong", schema: PongMessageSchema, summary: "Answers a ping." },
  {
    id: "error",
    schema: ErrorMessageSchema,
    summary: "A frame could not be handled, or a limit was hit.",
  },
];

/** The events a channel family carries. */
function eventsOf(def: ChannelDef): readonly EventDescriptor[] {
  return def.receives === "queue"
    ? QUEUE_EVENTS
    : def.receives === "runner"
      ? RUNNER_EVENTS
      : [...QUEUE_EVENTS, ...RUNNER_EVENTS];
}

/** Descriptions of address parameters. */
const PARAMETER_DESCRIPTIONS: Record<ChannelDef["parameters"][number], string> =
  {
    queue: "A queue name, matching `^[\\w.-]+$` (at most 200 characters).",
    jobId: "A job id, `encodeURIComponent`-escaped.",
    runner: "A runner id, matching `^[\\w.-]+$` (at most 200 characters).",
  };

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
    };
  }
  const carried = new Set<EventDescriptor>(
    channelsEnabled.flatMap((def) => [...eventsOf(def)]),
  );
  for (const descriptor of [...QUEUE_EVENTS, ...RUNNER_EVENTS]) {
    if (!carried.has(descriptor)) {
      continue;
    }
    messages[descriptor.messageName] = {
      name: descriptor.messageName,
      title: `${pascal(descriptor.kind)} ${descriptor.type}`,
      summary: descriptor.summary,
      contentType: "application/json",
      payload: emit(EVENT_ENVELOPES.get(descriptor)!),
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
      description: `The WebSocket itself (subprotocol \`${JOBS_API_WS_SUBPROTOCOL}\`, optional). Control messages travel here; events for the logical channels below arrive over it once subscribed.`,
      messages: Object.fromEntries(
        CONTROL_MESSAGES.map((control) => [control.id, messageRef(control.id)]),
      ),
      bindings: { ws: { method: "GET", bindingVersion: WS_BINDING_VERSION } },
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
    channels[def.kind] = {
      address: def.address,
      title: pascal(def.kind),
      description: `${def.description} A logical channel: subscribe with its name over the connection.`,
      ...(def.parameters.length > 0
        ? {
            parameters: Object.fromEntries(
              def.parameters.map((name) => [
                name,
                { description: PARAMETER_DESCRIPTIONS[name] },
              ]),
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
      title: `Receive ${def.kind} events`,
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
    ...(hasSecurity
      ? {
          security: Object.keys(securitySchemes).map((name) => ({
            $ref: `#/components/securitySchemes/${name}`,
          })),
        }
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
