/**
 * `gatewayAsyncApi(app)` (AD (e), plan `docs/plans/api-docs-generation/`
 * §5.2): the AsyncAPI 3.0 document of a booted Nest application's gateways,
 * discovered with `DiscoveryService` + `MetadataScanner` (no route table to
 * walk — a gateway is a provider with metadata, not a listed route).
 *
 * **Read this first — the envelope.** The wire format is fixed by
 * {@link MessageEventTypes} (`./BunWebSocketAdapter.ts`): every frame is a
 * socket.io-shaped packet `{ type, namespace, id?, data }`, so **the payload
 * a message documents is the whole envelope** — bun-jobs' `eventEnvelope`
 * precedent — never the bare handler payload. An inbound event ("say")
 * arrives as an `EVENT` packet `{ type: 2, namespace, id?, data: ["say",
 * <payload>] }`; the handler's `@ValidateMessage` schema sits at `data[1]`
 * (undecorated handlers document `{}` there — nothing to say). A declared
 * `ack` answers with an `ACK` packet `{ type: 3, namespace, id, data:
 * [<ack>] }` (the operation's `reply`). Outbound events (the gateway's
 * `@Emits` map) leave as `EVENT` packets `{ type: 2, namespace, data:
 * [event, <payload>] }`. The `CONNECT` (0), `DISCONNECT` (1) and `ERROR` (4)
 * frames, and the `["exception", { status, message, cause? }]` event a thrown
 * `WsException` becomes, are fixed: they are on every channel. `namespace` on
 * the wire is echoed, not routed — the channel's address is the gateway's
 * `path` + `namespace`.
 *
 * What is discovered per gateway (the class metadata): `GATEWAY_OPTIONS`'s
 * `path`/`namespace` (concatenated exactly as the adapter's `resolveRoute`)
 * → the channel's address; `PORT_METADATA` → the servers (one per distinct
 * port, plus a shared one for port-less gateways); `@SubscribeMessage` → a
 * `receive` operation; `"bun:validate:message"` (recorded by
 * `@ValidateMessage`) → the payload/ack schemas; `"bun:validate:emits"`
 * (`@Emits`) → the `send` operations. A wildcard route (`/*`) is unmappable —
 * an AsyncAPI address is a template, not a glob — and warns.
 *
 * `strict: "strict"` escalates every warning to a `ConfigError`, as
 * `generateAsyncApi` does. Deterministic: two calls over one app deep-equal.
 */
import type { INestApplication } from "@nestjs/common";
import type {
  AsyncApiDocument,
  AsyncApiOptions,
  AsyncApiResult,
  DocWarning,
  JsonSchemaLike,
} from "@kingsleyweb/bun-common/lib/docs";
import type { StandardSchemaV1 } from "@kingsleyweb/bun-common";
import {
  DiscoveryService,
  MetadataScanner,
  ModulesContainer,
} from "@nestjs/core";
import { ConfigError } from "@kingsleyweb/bun-common";
import {
  liftComponents,
  openApiSecurity,
  toAsyncApiSecurityScheme,
  toJsonSchema,
} from "@kingsleyweb/bun-common/lib/docs";
import { MessageEventTypes } from "./BunWebSocketAdapter";

/* ------------------------------------------------------------------ *
 * The metadata keys, by value
 * ------------------------------------------------------------------ *
 * `@nestjs/websockets` is an *optional* peer of this package, so its
 * constants are written here by value (they are version-stable strings)
 * rather than imported — the same convention `./wsValidation.ts` documents
 * for its own `"bun:*"` keys.
 */
const GATEWAY_METADATA = "websockets:is_gateway";
const GATEWAY_OPTIONS = "websockets:gateway_options";
const PORT_METADATA = "port";
const MESSAGE_MAPPING_METADATA = "websockets:message_mapping";
const MESSAGE_METADATA = "message";
/** `./wsValidation.ts`'s `@Emits` declaration (the gateway's server → client events). */
const EMITS_METADATA = "bun:validate:emits";
/** `./wsValidation.ts`'s `@ValidateMessage` record: `{ schema, ack }`. */
const MESSAGE_VALIDATE_METADATA = "bun:validate:message";

/** The WebSocket channel binding version the document declares. */
const WS_BINDING_VERSION = "0.1.0";

/** One gateway, discovered. */
interface GatewayInfo {
  /** The class. */
  metatype: { name?: string };
  /** The address (`path` + `namespace`, `"/"` when neither), as the adapter resolves it. */
  route: string;
  /** The namespace the frames echo (`"/"` when none). */
  namespace: string;
  /** `PORT_METADATA` — `0` when the gateway shares the app's server. */
  port: number;
  /** The `@SubscribeMessage` handlers: the event, its `@ValidateMessage` schemas. */
  handlers: {
    event: string;
    schema?: StandardSchemaV1;
    ack?: StandardSchemaV1;
  }[];
  /** The `@Emits` map (server → client), when declared. */
  emits: Readonly<Record<string, StandardSchemaV1 | null>> | undefined;
}

/** Whether `value` is a plain object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** The adapter's `resolveRoute`: `path` followed by `namespace`, `"/"` when both are absent. */
function resolveRoute(path?: string, namespace?: string): string {
  const segment = (one: string | undefined): string => {
    if (typeof one !== "string" || one.length === 0 || one === "/") return "";
    const leading = one.startsWith("/") ? one : `/${one}`;
    return leading.length > 1 && leading.endsWith("/")
      ? leading.slice(0, -1)
      : leading;
  };
  const route = `${segment(path)}${segment(namespace)}`;
  return route.length > 0 ? route : "/";
}

/** `chat-admin` → `ChatAdmin`, for operation ids and message keys. */
function pascal(name: string): string {
  return name
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

/** The channel id derived from a route: `/ws/chat` → `wsChat`; `/` → `root`. */
function channelIdFromRoute(route: string): string {
  if (route === "/") return "root";
  const words = route.split(/[^\p{L}\p{N}]+/u).filter((word) => word !== "");
  const [first = "root", ...rest] = words;
  return (
    first.charAt(0).toLowerCase() +
    first.slice(1) +
    rest.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("")
  );
}

/** A component-key-safe form of an id (AsyncAPI keys match `^[\w.\-]+$`). */
function keySafe(id: string): string {
  return id.replaceAll(/[^\w.-]+/gu, "-");
}

/** JSON with sorted keys and no `$schema`, so two JSON Schemas compare by content. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) => {
    if (typeof child !== "object" || child === null || Array.isArray(child)) {
      return child;
    }
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(child).sort()) {
      if (key !== "$schema") {
        sorted[key] = (child as Record<string, unknown>)[key];
      }
    }
    return sorted;
  });
}

/** The gateway options a class carries (`GATEWAY_OPTIONS`), as an object. */
function gatewayOptionsOf(metatype: object): Record<string, unknown> {
  const options: unknown = Reflect.getMetadata(GATEWAY_OPTIONS, metatype);
  return isPlainObject(options) ? options : {};
}

/**
 * What {@link gatewayAsyncApi} takes: bun-common's `AsyncApiOptions` minus the
 * fields the explorer supplies itself (`servers` come from the gateways'
 * ports; there is no route walk to `filter`), with `title`/`version`
 * optional.
 */
export type GatewayAsyncApiOptions = Omit<
  AsyncApiOptions,
  "servers" | "filter" | "title" | "version"
> & {
  /** `info.title`. Default: `"WebSocket gateways"`. */
  title?: string;
  /** `info.version`. Default: `"0.0.0"`. */
  version?: string;
};

/**
 * Builds the AsyncAPI 3.0 document of the booted app's gateways. See the
 * module header for the envelope contract the messages document.
 *
 * @param app A booted Nest application (one whose gateways have registered —
 *   after `app.init()`/`app.listen()`), using `BunWebSocketAdapter`.
 * @param options See {@link GatewayAsyncApiOptions}.
 * @throws ConfigError on a duplicate channel id, and — under
 *   `strict: "strict"` — on any warning (a wildcard gateway route, an
 *   unconvertible schema).
 */
export function gatewayAsyncApi(
  app: INestApplication,
  options: GatewayAsyncApiOptions = {},
): AsyncApiResult {
  const strict = options.strict === "strict";
  const warnings: DocWarning[] = [];
  const warn = (message: string, route?: string): void => {
    warnings.push({
      stage: "operation",
      message,
      ...(route === undefined ? {} : { route }),
    });
  };

  /* The gateways, discovered. DiscoveryService is built on the app's
   * ModulesContainer rather than resolved with `app.get(DiscoveryService)`:
   * it needs only the container, and resolving an unregistered token through
   * `app.get` is a path this build avoids deliberately (the workspace's Nest
   * 12.2.0 does not auto-register it). */
  const discovery = new DiscoveryService(app.get(ModulesContainer));
  const scanner = new MetadataScanner();
  const gateways: GatewayInfo[] = [];
  for (const wrapper of discovery.getProviders()) {
    const metatype = wrapper.metatype;
    if (metatype === undefined || metatype === null) continue;
    if (Reflect.getMetadata(GATEWAY_METADATA, metatype) !== true) continue;
    const gatewayOptions = gatewayOptionsOf(metatype);
    // `PORT_METADATA` is 0 unless the port was the decorator's first
    // (numeric) argument; `{ port }` in the options object is the other form.
    const metaPort: unknown = Reflect.getMetadata(PORT_METADATA, metatype);
    const port: unknown =
      typeof metaPort === "number" && metaPort > 0
        ? metaPort
        : gatewayOptions.port;
    const namespace =
      typeof gatewayOptions.namespace === "string"
        ? gatewayOptions.namespace
        : undefined;
    const route = resolveRoute(
      typeof gatewayOptions.path === "string" ? gatewayOptions.path : undefined,
      namespace,
    );
    const handlers: GatewayInfo["handlers"] = [];
    for (const methodName of scanner.getAllFilteredMethodNames(
      metatype.prototype as object,
    )) {
      const callback = (metatype.prototype as Record<string, unknown>)[
        methodName
      ];
      if (
        typeof callback !== "function" ||
        Reflect.getMetadata(MESSAGE_MAPPING_METADATA, callback) !== true
      ) {
        continue;
      }
      const event: unknown = Reflect.getMetadata(MESSAGE_METADATA, callback);
      const validated: unknown = Reflect.getMetadata(
        MESSAGE_VALIDATE_METADATA,
        callback,
      );
      const record = isPlainObject(validated) ? validated : undefined;
      handlers.push({
        event: typeof event === "string" ? event : methodName,
        ...(record?.schema !== undefined
          ? { schema: record.schema as StandardSchemaV1 }
          : {}),
        ...(record?.ack !== undefined
          ? { ack: record.ack as StandardSchemaV1 }
          : {}),
      });
    }
    const emits: unknown = Reflect.getMetadata(EMITS_METADATA, metatype);
    gateways.push({
      metatype: metatype as { name?: string },
      route,
      namespace: namespace ?? "/",
      port: typeof port === "number" && port > 0 ? port : 0,
      handlers,
      emits: isPlainObject(emits)
        ? (emits as Readonly<Record<string, StandardSchemaV1 | null>>)
        : undefined,
    });
  }

  /* The schema components (toJsonSchema + liftComponents, the generators'
   * assembly kept small): a name claimed twice by different bodies is renamed
   * deterministically, first claim keeping the name. */
  const components = new Map<string, JsonSchemaLike>();
  const claimed = new Map<string, string>();
  const emitSchema = (
    schema: StandardSchemaV1,
    where: string,
  ): JsonSchemaLike => {
    const json = toJsonSchema(schema, {
      direction: "input",
      ...(options.converters === undefined
        ? {}
        : { converters: options.converters }),
      onWarning: (warning) => warn(`${where}: ${warning.message}`),
    });
    const name =
      options.componentName?.(schema) ??
      (typeof json.$id === "string" ? json.$id : undefined) ??
      (typeof json.title === "string" ? json.title : undefined);
    const lifted = liftComponents(json, {
      ...(name === undefined ? {} : { name }),
      onWarning: (warning) => warn(`${where}: ${warning.message}`),
    });
    for (const [componentName, body] of Object.entries(lifted.components)) {
      const canonical = canonicalJson(body);
      if (claimed.get(componentName) === canonical) continue;
      let finalName = componentName;
      if (claimed.has(componentName)) {
        let suffix = 2;
        while (
          claimed.has(`${componentName}${suffix}`) &&
          claimed.get(`${componentName}${suffix}`) !== canonical
        ) {
          suffix++;
        }
        finalName = `${componentName}${suffix}`;
        warn(
          `two schemas claimed the component name "${componentName}"; the later one was renamed "${finalName}"`,
        );
      }
      claimed.set(finalName, canonical);
      components.set(finalName, body);
    }
    return lifted.schema;
  };

  /* ---------------------------------------------------------------- *
   * The channels, messages, operations and servers.
   * ---------------------------------------------------------------- */
  const channels: Record<string, unknown> = {};
  const operations: Record<string, unknown> = {};
  const messages: Record<string, unknown> = {};
  const servers: Record<string, unknown> = {};
  const channelIds = new Map<string, string>();

  /** The server one port documents; port-less gateways share "app". */
  const serverForPort = (port: number): string => {
    if (port === 0) {
      servers.app ??= {
        host: "{host}",
        pathname: "/",
        protocol: "ws",
        description: "The application's own server (the gateway shares it).",
        variables: {
          host: {
            default: "localhost",
            description:
              "The host (and port) the application listens on; the bound port is known only once it does.",
          },
        },
      };
      return "app";
    }
    const name = `port${port}`;
    servers[name] ??= {
      host: `localhost:${port}`,
      pathname: "/",
      protocol: "ws",
      description: `The gateway's dedicated server (its @WebSocketGateway port).`,
    };
    return name;
  };

  /** One fixed frame's message: the CONNECT/DISCONNECT/ERROR packets. */
  const fixedMessage = (
    namespace: string,
    type:
      | MessageEventTypes.CONNECT
      | MessageEventTypes.DISCONNECT
      | MessageEventTypes.ERROR,
    summary: string,
  ): Record<string, unknown> => ({
    name: MessageEventTypes[type].toLowerCase(),
    summary,
    contentType: "application/json",
    payload: {
      type: "object",
      properties: {
        type: { const: type, description: "The packet type." },
        namespace: {
          const: namespace,
          description: "The namespace the packet names; echoed, not routed.",
        },
        ...(type === MessageEventTypes.ERROR
          ? { data: { type: "string", description: "The error message." } }
          : {}),
      },
      required: ["type", "namespace"],
    },
  });

  for (const gateway of gateways) {
    const gatewayName = gateway.metatype.name ?? "gateway";
    if (gateway.route === "/*" || gateway.route.endsWith("/*")) {
      warn(
        `${gatewayName}: the route "${gateway.route}" is a wildcard; an AsyncAPI address is a template, not a glob — the gateway is left out of the document`,
        gateway.route,
      );
      continue;
    }
    const id = keySafe(channelIdFromRoute(gateway.route));
    const owner = channelIds.get(id);
    if (owner !== undefined) {
      throw new ConfigError(
        `Two gateways share the channel id "${id}" (${owner} and ${gatewayName})`,
        { channelId: id, first: owner, second: gatewayName },
      );
    }
    channelIds.set(id, gatewayName);
    const server = serverForPort(gateway.port);
    const channelMessages: Record<string, unknown> = {};
    const register = (key: string, message: Record<string, unknown>): void => {
      const messageKey = `${id}.${key}`;
      messages[messageKey] = message;
      channelMessages[keySafe(key)] = {
        $ref: `#/components/messages/${messageKey}`,
      };
    };
    const messageRef = (key: string) => ({
      $ref: `#/channels/${id}/messages/${keySafe(key)}`,
    });

    /* The inbound events: one EVENT-envelope message and one receive
     * operation per handler, the @ValidateMessage payload at data[1] ({} when
     * undecorated) and its ack as the reply's ACK packet. */
    const inboundKeys: string[] = [];
    for (const handler of gateway.handlers) {
      const key = `in.${handler.event}`;
      inboundKeys.push(key);
      register(key, {
        name: handler.event,
        summary: `The client → server "${handler.event}" event.`,
        contentType: "application/json",
        payload: {
          type: "object",
          description: `An EVENT packet; the handler's payload is at \`data[1]\`${
            handler.schema === undefined
              ? " (nothing is declared for it — it documents as `{}`)"
              : ""
          }.`,
          properties: {
            type: { const: MessageEventTypes.EVENT, description: "EVENT." },
            namespace: {
              const: gateway.namespace,
              description: "Echoed, not routed.",
            },
            id: {
              oneOf: [{ type: "string" }, { type: "number" }],
              description:
                "Asks for an acknowledgement (the handler's @Ack()); the ACK answers with this id.",
            },
            data: {
              type: "array",
              description: "`[event, ...args]`; the payload is `data[1]`.",
              items: [
                { const: handler.event },
                handler.schema === undefined
                  ? {}
                  : emitSchema(
                      handler.schema,
                      `${gatewayName}.${handler.event} payload`,
                    ),
              ],
              minItems: 1,
            },
          },
          required: ["type", "namespace", "data"],
        },
      });
      const operationId = keySafe(
        `receive${pascal(id)}${pascal(handler.event)}`,
      );
      if (Object.hasOwn(operations, operationId)) {
        throw new ConfigError(
          `Two operations share the id "${operationId}" (gateway ${gatewayName})`,
          { operationId, gateway: gatewayName },
        );
      }
      let reply: Record<string, unknown> | undefined;
      if (handler.ack !== undefined) {
        const ackKey = `${key}.ack`;
        register(ackKey, {
          name: `${handler.event} ack`,
          summary: `The ACK answering "${handler.event}" (type 3, the handler's returned value at \`data[0]\`).`,
          contentType: "application/json",
          payload: {
            type: "object",
            properties: {
              type: { const: MessageEventTypes.ACK, description: "ACK." },
              namespace: { const: gateway.namespace },
              id: {
                oneOf: [{ type: "string" }, { type: "number" }],
                description: "The id of the event this acknowledges.",
              },
              data: {
                type: "array",
                items: [
                  emitSchema(
                    handler.ack,
                    `${gatewayName}.${handler.event} ack`,
                  ),
                ],
                minItems: 1,
              },
            },
            required: ["type", "namespace", "id", "data"],
          },
        });
        reply = {
          channel: { $ref: `#/channels/${id}` },
          messages: [messageRef(ackKey)],
        };
      }
      operations[operationId] = {
        action: "receive",
        channel: { $ref: `#/channels/${id}` },
        messages: [messageRef(key)],
        ...(reply === undefined ? {} : { reply }),
      };
    }

    /* The lifecycle frames and the fixed outbound ones. */
    register(
      "connect",
      fixedMessage(
        gateway.namespace,
        MessageEventTypes.CONNECT,
        "Opens the connection (sent once, when it does).",
      ),
    );
    register(
      "disconnect",
      fixedMessage(
        gateway.namespace,
        MessageEventTypes.DISCONNECT,
        "Closes the connection.",
      ),
    );
    register(
      "error",
      fixedMessage(
        gateway.namespace,
        MessageEventTypes.ERROR,
        "An ERROR frame: the connection could not be established or was broken.",
      ),
    );
    register("exception", {
      name: "exception",
      summary:
        'A thrown WsException, as the EVENT packet `["exception", { status, message, cause? }]` (the adapter routes exceptions through `emit`).',
      contentType: "application/json",
      payload: {
        type: "object",
        properties: {
          type: { const: MessageEventTypes.EVENT, description: "EVENT." },
          namespace: { const: gateway.namespace },
          data: {
            type: "array",
            items: [
              { const: "exception" },
              {
                type: "object",
                properties: {
                  status: { const: "error" },
                  message: { type: "string" },
                  cause: {},
                },
                required: ["status", "message"],
              },
            ],
            minItems: 2,
          },
        },
        required: ["type", "namespace", "data"],
      },
    });

    /* The outbound events (@Emits). */
    const outboundKeys: string[] = ["exception", "error"];
    for (const [event, schema] of Object.entries(gateway.emits ?? {})) {
      const key = `out.${event}`;
      outboundKeys.push(key);
      register(key, {
        name: event,
        summary: `The server → client "${event}" event (the gateway's @Emits declaration).`,
        contentType: "application/json",
        payload: {
          type: "object",
          description: "An EVENT packet; the event's payload is at `data[1]`.",
          properties: {
            type: { const: MessageEventTypes.EVENT, description: "EVENT." },
            namespace: {
              const: gateway.namespace,
              description: "Echoed, not routed.",
            },
            data: {
              type: "array",
              description:
                "`[event, payload]` (a `null`-declared event carries none).",
              items: [
                { const: event },
                ...(schema === null
                  ? []
                  : [emitSchema(schema, `${gatewayName}.${event} emit`)]),
              ],
              minItems: 1,
            },
          },
          required: ["type", "namespace", "data"],
        },
      });
    }

    operations[keySafe(`lifecycle${pascal(id)}`)] = {
      action: "receive",
      channel: { $ref: `#/channels/${id}` },
      title: "Connection lifecycle",
      messages: [messageRef("connect"), messageRef("disconnect")],
    };
    operations[keySafe(`send${pascal(id)}`)] = {
      action: "send",
      channel: { $ref: `#/channels/${id}` },
      messages: outboundKeys.map((key) => messageRef(key)),
    };

    channels[id] = {
      address: gateway.route,
      title: gatewayName,
      description: [
        `The ${gatewayName} gateway's socket (${gateway.route}).`,
        "Every frame is a socket.io-shaped packet `{ type, namespace, id?, data }` (`MessageEventTypes`): an event is `{ type: 2, namespace, id?, data: [event, ...args] }` with the payload at `data[1]`, answered — when it asks with an `id` and the handler declares an `ack` — by an ACK `{ type: 3, namespace, id, data: [<ack>] }`. The `namespace` on the wire is echoed, not routed.",
      ].join("\n\n"),
      servers: [{ $ref: `#/servers/${server}` }],
      messages: channelMessages,
      bindings: {
        ws: { method: "GET", bindingVersion: WS_BINDING_VERSION },
      },
    };
  }

  /* Security (the OpenAPI declarations, mapped — bun-common's own rule: one
   * scheme per alternative on a server; a conjunctive requirement warns and is
   * left out). Applied to every discovered server. */
  const security = openApiSecurity(
    options.securitySchemes === undefined && options.security === undefined
      ? {}
      : {
          ...(options.securitySchemes === undefined
            ? {}
            : { securitySchemes: options.securitySchemes }),
          ...(options.security === undefined
            ? {}
            : { security: options.security }),
        },
  );
  const securitySchemes: Record<string, unknown> = {};
  if (security.securitySchemes !== undefined) {
    for (const [name, scheme] of Object.entries(security.securitySchemes)) {
      const mapped = toAsyncApiSecurityScheme(scheme);
      securitySchemes[name] = {
        ...mapped.scheme,
        ...(mapped.browserNote === undefined
          ? {}
          : {
              description: [
                (mapped.scheme as { description?: string }).description,
                `Note — ${mapped.browserNote}`,
              ]
                .filter((part): part is string => typeof part === "string")
                .join(" "),
            }),
      };
    }
  }
  const serverSecurity: Record<string, unknown>[] = [];
  for (const requirement of security.security ?? []) {
    const names = Object.keys(requirement);
    if (names.length !== 1) {
      if (names.length > 1) {
        warn(
          `a conjunctive security requirement (${names.join(" + ")}) cannot be expressed in AsyncAPI 3.0's server.security (one scheme per alternative) — it was left out`,
        );
      }
      continue;
    }
    const name = names[0];
    const scopes = requirement[name] ?? [];
    serverSecurity.push(
      scopes.length === 0
        ? { $ref: `#/components/securitySchemes/${name}` }
        : { ...(securitySchemes[name] as object), scopes: [...scopes] },
    );
  }
  if (serverSecurity.length > 0) {
    for (const server of Object.values(servers)) {
      (server as Record<string, unknown>).security = serverSecurity;
    }
  }

  const document: AsyncApiDocument = {
    asyncapi: "3.0.0",
    info: {
      title: options.title ?? "WebSocket gateways",
      version: options.version ?? "0.0.0",
      ...(options.description === undefined
        ? {}
        : { description: options.description }),
      ...(options.info === undefined ? {} : { ...options.info }),
    },
    defaultContentType: "application/json",
    ...(Object.keys(servers).length > 0
      ? {
          servers: Object.fromEntries(
            Object.entries(servers).sort(([a], [b]) => (a < b ? -1 : 1)),
          ),
        }
      : {}),
    ...(Object.keys(channels).length > 0 ? { channels } : {}),
    ...(Object.keys(operations).length > 0 ? { operations } : {}),
    ...(components.size > 0 ||
    Object.keys(messages).length > 0 ||
    Object.keys(securitySchemes).length > 0
      ? {
          components: {
            ...(components.size > 0
              ? {
                  schemas: Object.fromEntries(
                    [...components].sort(([a], [b]) => (a < b ? -1 : 1)),
                  ),
                }
              : {}),
            ...(Object.keys(messages).length > 0
              ? {
                  messages: Object.fromEntries(
                    Object.entries(messages).sort(([a], [b]) =>
                      a < b ? -1 : 1,
                    ),
                  ),
                }
              : {}),
            ...(Object.keys(securitySchemes).length > 0
              ? { securitySchemes }
              : {}),
          },
        }
      : {}),
  };

  if (strict && warnings.length > 0) {
    throw new ConfigError(
      `gatewayAsyncApi() in strict mode: ${warnings.length} warning(s):\n${warnings
        .map(
          (warning) =>
            `- [${warning.stage}]${warning.route === undefined ? "" : ` ${warning.route}:`} ${warning.message}`,
        )
        .join("\n")}`,
      { warnings: warnings.map((warning) => ({ ...warning })) },
    );
  }
  return { document, warnings };
}
