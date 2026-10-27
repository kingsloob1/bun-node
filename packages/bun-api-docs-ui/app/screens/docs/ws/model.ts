import type { SpecDocument } from "../../../api/docs";
import { DEFAULT_EXTENSION_PREFIXES } from "../../../../lib/shared/config.ts";
import { resolveRef } from "../schema/resolve";

/**
 * The WebSocket reference's pure half: the AsyncAPI 3.0 document read into
 * what the screen shows (header, sidebar items, per-item detail, the
 * specification extensions).
 *
 * Everything is read defensively: the document is JSON from the server, and a
 * field this reader does not find is left out rather than guessed.
 *
 * The extensions are vendor-neutral: each is named on its node as
 * `<prefix>-<name>` and read from the first prefix of
 * {@link WsModelOptions.extensions} that carries it (default
 * `["x-bun-common", "x-bun-jobs"]`), so a document written for either
 * vocabulary — or an operator's own — renders, and an extension under any
 * other prefix is ignored.
 */

/** A JSON object, loosely. */
type Json = Record<string, unknown>;

/** Whether a value is a plain JSON object. */
function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string field, or `undefined`. */
function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A number field, or `undefined`. */
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** Options of {@link readWsDoc}. */
export interface WsModelOptions {
  /**
   * The extension prefixes, first hit winning. Defaults to
   * `["x-bun-common", "x-bun-jobs"]`.
   */
  extensions?: readonly string[];
  /**
   * The subprotocol shown when the document states none, e.g. the client
   * contract's. Unset: the panel says the document does not state one.
   */
  defaultSubprotocol?: string;
}

/** One extension read: the full key it was found under, and its value. */
interface FoundExtension {
  /** The full key, e.g. `x-bun-jobs-limits`. */
  key: string;
  /** Its value. */
  value: unknown;
}

/** Reads the `<prefix>-<name>` extension of a node from the first prefix carrying it. */
function extensionOf(
  node: Json | undefined,
  name: string,
  prefixes: readonly string[],
): FoundExtension | undefined {
  if (node === undefined) {
    return undefined;
  }
  for (const prefix of prefixes) {
    const key = `${prefix}-${name}`;
    if (Object.hasOwn(node, key)) {
      return { key, value: node[key] };
    }
  }
  return undefined;
}

/** The last segment of a local `$ref` (`#/channels/queue` → `queue`), unescaped. */
export function refName(ref: unknown): string | undefined {
  const pointer = isObject(ref) ? str(ref.$ref) : undefined;
  if (pointer === undefined || !pointer.startsWith("#/")) {
    return undefined;
  }
  const last = pointer.split("/").at(-1);
  return last === undefined
    ? undefined
    : last.replaceAll("~1", "/").replaceAll("~0", "~");
}

/** The app path of an item, keeping the search. */
export function itemPath(slug: string, query = ""): string {
  return `/ws/${encodeURIComponent(slug)}${query ? `?${new URLSearchParams({ q: query }).toString()}` : ""}`;
}

/** The kinds of sidebar item. */
export type WsItemKind =
  | "channel"
  | "operation"
  | "message"
  | "limits"
  | "close-codes"
  | "upgrade-refusals";

/** The URL slug of an item: `channel-queue`, `operation-subscribe`, `message-queue.completed`, `limits`. */
export function itemSlug(kind: WsItemKind, key?: string): string {
  return key === undefined ? kind : `${kind}-${key}`;
}

/** A channel parameter. */
export interface WsParameter {
  /** Its name in the address template (`queue`, `jobId`, `runner`). */
  name: string;
  /** What it is. */
  description: string | undefined;
  /**
   * The value's JSON Schema, from the `<prefix>-schema` extension (AsyncAPI
   * 3.0's Parameter Object has no `schema` field); `undefined` when the
   * document gives none.
   */
  schema: Json | undefined;
}

/** One channel: the `connection`, or a logical family. */
export interface WsChannel {
  /** Its key under `channels` (`connection`, `queue`, ...). */
  key: string;
  /** The item slug. */
  slug: string;
  /** Its title, or the key. */
  title: string;
  /** The address: the socket path for `connection`, a name template otherwise. */
  address: string;
  /** Its description. */
  description: string | undefined;
  /** Address parameters, in template order. */
  parameters: WsParameter[];
  /** Message ids it carries, in document order. */
  messages: string[];
  /** The WebSocket binding's method, when declared. */
  bindingMethod: string | undefined;
  /** Whether this is the transport itself rather than a logical channel. */
  isConnection: boolean;
}

/** One operation. */
export interface WsOperation {
  /** Its key under `operations`. */
  key: string;
  /** The item slug. */
  slug: string;
  /** Its title, or the key. */
  title: string;
  /** Its summary. */
  summary: string | undefined;
  /** `send` (client → server) or `receive` (server → client). */
  action: "send" | "receive" | undefined;
  /** The channel key it is on. */
  channel: string | undefined;
  /** The message ids it sends or receives. */
  messages: string[];
  /** The reply, for a request/response operation. */
  reply: {
    /** The channel key the reply arrives on. */
    channel: string | undefined;
    /** The message ids the reply may be. */
    messages: string[];
  } | null;
  /** The permission it needs (the `<prefix>-action` extension). */
  permission: string | undefined;
}

/** One message. */
export interface WsMessage {
  /** Its key under `components.messages` (`subscribe`, `queue.completed`). */
  key: string;
  /** The item slug. */
  slug: string;
  /** Its `name`, or the key. */
  name: string;
  /** Its title. */
  title: string | undefined;
  /** Its summary. */
  summary: string | undefined;
  /** Its content type. */
  contentType: string | undefined;
  /** The payload schema as written (often a `$ref`). */
  payload: unknown;
  /** Its examples, when the document gives any. */
  examples: {
    /** The example's name. */
    name: string | undefined;
    /** Its summary. */
    summary: string | undefined;
    /** Its payload. */
    payload: unknown;
  }[];
  /**
   * For an event message — one whose key is `<kind>.<type>`
   * (`queue.completed`) — the two parts; `null` for a control message (a key
   * with no dot).
   */
  event: {
    /** The part before the first dot (`queue`). */
    kind: string;
    /** The part after it (`completed`). */
    type: string;
  } | null;
}

/** One `<prefix>-close-codes` entry. */
export interface WsCloseCode {
  /** The close code. */
  code: number;
  /** Its name. */
  name: string;
  /** When it is sent. */
  description: string;
}

/** One `<prefix>-upgrade-refusals` entry. */
export interface WsUpgradeRefusal {
  /** The HTTP status. */
  status: number;
  /** The problem's `code`. */
  code: string;
  /** When it is sent. */
  description: string;
  /** The response's content type. */
  contentType: string | undefined;
  /** Headers it carries. */
  headers: Record<string, string>;
}

/** `<prefix>-limits`, as far as it was found. */
export interface WsLimits {
  /** Every numeric limit, by name, in document order. */
  values: [name: string, value: number][];
  /** The replay ring: its size and age, `false` when replay is off, `undefined` when not stated. */
  replay:
    | {
        /** How many events it keeps. */
        size: number | undefined;
        /** How old an event it keeps, in ms. */
        maxAgeMs: number | undefined;
      }
    | false
    | undefined;
}

/** A security scheme, as `components.securitySchemes` declares it. */
export interface WsSecurityScheme {
  /** Its name. */
  name: string;
  /** Its AsyncAPI type (`http`, `httpApiKey`, `oauth2`, ...). */
  type: string | undefined;
  /** A one-line reading of it (`bearer`, `header X-Key`). */
  detail: string | undefined;
  /** Its description. */
  description: string | undefined;
  /** What a browser WebSocket cannot carry (the `<prefix>-note` extension). */
  note: string | undefined;
}

/** One requirement: every scheme in it is needed together. */
export type WsRequirement = {
  /** The scheme. */
  scheme: string;
  /** The scopes it needs. */
  scopes: string[];
}[];

/** The document's server. */
export interface WsServer {
  /** Its key under `servers`: `api`, or the first server's when there is no `api`. */
  key: string;
  /** The host, as served (the request's own when fetched over HTTP). */
  host: string;
  /** Whether the host is still the `{host}` template (the in-process document). */
  hostIsTemplate: boolean;
  /** The template's default host, when it is one. */
  hostDefault: string | undefined;
  /** The socket's path. */
  pathname: string | undefined;
  /** `ws` or `wss`. */
  protocol: string | undefined;
  /** Its description. */
  description: string | undefined;
  /** The socket URL, when host and protocol are known. */
  url: string | undefined;
}

/** The whole document, read. */
export interface WsDoc {
  /** `info.title`. */
  title: string;
  /** `info.version`. */
  version: string | undefined;
  /** `info.description`. */
  description: string | undefined;
  /** `servers.api` (or the first server). */
  server: WsServer | null;
  /** The subprotocol, and where it was read from. */
  subprotocol: {
    /** The subprotocol, or `undefined` when the document states none and no default was configured. */
    value: string | undefined;
    /** Whether it was read from the document rather than assumed. */
    fromDocument: boolean;
    /**
     * Where it came from: the `<prefix>-subprotocol` extension on the server
     * (`servers.api`, see {@link WsServer.key}), else on the connection
     * channel; the connection channel's description (a document that states
     * it only there); or {@link WsModelOptions.defaultSubprotocol} when the
     * document says nothing. {@link subprotocolSource} words it.
     */
    source:
      | "server-extension"
      | "connection-extension"
      | "connection-prose"
      | "default";
  };
  /** The full key the subprotocol extension was read from (e.g. `x-bun-jobs-subprotocol`), when it was one. */
  subprotocolKey?: string;
  /** The full keys the connection's extensions were found under (e.g. `x-bun-jobs-limits`), for the panels to name. */
  extensionKeys: {
    /** The key the security requirements were read from. */
    security?: string;
    /** The key the limits were read from. */
    limits?: string;
    /** The key the close codes were read from. */
    closeCodes?: string;
    /** The key the upgrade refusals were read from. */
    upgradeRefusals?: string;
  };
  /** Declared schemes that a requirement names. */
  securitySchemes: WsSecurityScheme[];
  /** Every requirement (the `<prefix>-security` extension, else the native list): any one suffices. */
  requirements: WsRequirement[];
  /** Whether some requirement could not be expressed in the native `security` list (it names several schemes). */
  conjunctive: boolean;
  /** Channels: `connection` first, then the families in document order. */
  channels: WsChannel[];
  /** Operations, in document order. */
  operations: WsOperation[];
  /** Messages: control messages, then events. */
  messages: WsMessage[];
  /** `<prefix>-limits`, or `null` when absent. */
  limits: WsLimits | null;
  /** `<prefix>-close-codes`. */
  closeCodes: WsCloseCode[];
  /** `<prefix>-upgrade-refusals`. */
  refusals: WsUpgradeRefusal[];
}

/**
 * Where the subprotocol shown was read from, in words: `from servers.api
 * (x-bun-jobs-subprotocol)`, `from the connection channel
 * (x-bun-common-subprotocol)`, `from the connection channel's description`, or
 * `not stated in the document` (plus `; the configured default` when one was).
 */
export function subprotocolSource(doc: WsDoc): string {
  switch (doc.subprotocol.source) {
    case "server-extension":
      return `from servers.${doc.server?.key ?? "api"} (${doc.subprotocolKey ?? "subprotocol extension"})`;
    case "connection-extension":
      return `from the connection channel (${doc.subprotocolKey ?? "subprotocol extension"})`;
    case "connection-prose":
      return "from the connection channel's description";
    case "default":
      return doc.subprotocol.value === undefined
        ? "not stated in the document"
        : "not stated; the configured default";
  }
}

/** Reads the subprotocol from the connection channel's prose (`subprotocol \`bun-jobs.v1\``). */
function readSubprotocol(description: string | undefined): string | undefined {
  return description?.match(/subprotocol `([^`]+)`/)?.[1];
}

/** Reads a scheme's one-line detail. */
function schemeDetail(scheme: Json): string | undefined {
  const type = str(scheme.type);
  switch (type) {
    case "http":
      return [str(scheme.scheme), str(scheme.bearerFormat)]
        .filter(Boolean)
        .join(", ");
    case "httpApiKey":
      return `${str(scheme.in) ?? "?"} ${str(scheme.name) ?? "?"}`;
    case "oauth2": {
      const scopes = isObject(scheme.flows)
        ? Object.values(scheme.flows).flatMap((flow) =>
            isObject(flow) && isObject(flow.availableScopes)
              ? Object.keys(flow.availableScopes)
              : [],
          )
        : [];
      return scopes.length > 0
        ? `scopes: ${[...new Set(scopes)].join(", ")}`
        : undefined;
    }
    case "openIdConnect":
      return str(scheme.openIdConnectUrl);
    default:
      return undefined;
  }
}

/** Reads a requirement object (`{ bearer: [], key: ["read"] }`). */
function readRequirement(requirement: unknown): WsRequirement | null {
  if (!isObject(requirement)) {
    return null;
  }
  return Object.entries(requirement).map(([scheme, scopes]) => ({
    scheme,
    scopes: Array.isArray(scopes)
      ? scopes.filter((scope): scope is string => typeof scope === "string")
      : [],
  }));
}

/** Reads a native `server.security` entry: a `$ref`, or an inline scheme with `scopes`. */
function readNativeRequirement(
  entry: unknown,
  schemes: Json,
): WsRequirement | null {
  const name = refName(entry);
  if (name !== undefined) {
    return [{ scheme: name, scopes: [] }];
  }
  if (!isObject(entry)) {
    return null;
  }
  // An inline copy of a declared scheme: find it by its fields.
  const { scopes, ...rest } = entry;
  const match = Object.entries(schemes).find(
    ([, scheme]) =>
      isObject(scheme) &&
      Object.entries(rest).every(
        ([key, value]) => JSON.stringify(scheme[key]) === JSON.stringify(value),
      ),
  );
  return [
    {
      scheme: match?.[0] ?? str(rest.type) ?? "(inline)",
      scopes: Array.isArray(scopes)
        ? scopes.filter((scope): scope is string => typeof scope === "string")
        : [],
    },
  ];
}

/** The ids of a list of message `$ref`s. */
function messageIds(list: unknown): string[] {
  const entries = Array.isArray(list)
    ? list
    : isObject(list)
      ? Object.values(list)
      : [];
  return entries.flatMap((entry) => {
    const name = refName(entry);
    return name === undefined ? [] : [name];
  });
}

/** Reads the event kind and type from a message key (`queue.completed`); `null` for a control message. */
function eventOf(key: string): WsMessage["event"] {
  const match = /^([^.]+)\.(.+)$/.exec(key);
  return match ? { kind: match[1]!, type: match[2]! } : null;
}

/** Reads the numeric limits and the replay setting. */
function readLimits(raw: unknown): WsLimits | null {
  if (!isObject(raw)) {
    return null;
  }
  const values: [string, number][] = [];
  for (const [name, value] of Object.entries(raw)) {
    const n = num(value);
    if (name !== "replay" && n !== undefined) {
      values.push([name, n]);
    }
  }
  const replay = raw.replay;
  return {
    values,
    replay:
      replay === false
        ? false
        : isObject(replay)
          ? { size: num(replay.size), maxAgeMs: num(replay.maxAgeMs) }
          : undefined,
  };
}

/** Reads the document into what the screen shows. */
export function readWsDoc(
  doc: SpecDocument,
  options: WsModelOptions = {},
): WsDoc {
  const prefixes = options.extensions ?? DEFAULT_EXTENSION_PREFIXES;
  const info = isObject(doc.info) ? doc.info : {};
  const components = isObject(doc.components) ? doc.components : {};
  const rawSchemes = isObject(components.securitySchemes)
    ? components.securitySchemes
    : {};

  // The server.
  const servers = isObject(doc.servers) ? doc.servers : {};
  const serverKey = isObject(servers.api)
    ? "api"
    : Object.keys(servers).find((key) => isObject(servers[key]));
  const rawServer =
    serverKey === undefined ? undefined : (servers[serverKey] as Json);
  let server: WsServer | null = null;
  let requirements: WsRequirement[] = [];
  let nativeCount = 0;
  let securityKey: string | undefined;
  if (rawServer) {
    const variables = isObject(rawServer.variables) ? rawServer.variables : {};
    const hostVar = isObject(variables.host) ? variables.host : undefined;
    const rawHost = str(rawServer.host) ?? "";
    const hostIsTemplate = /\{[^}]+\}/.test(rawHost);
    const hostDefault = str(hostVar?.default);
    const pathname = str(rawServer.pathname);
    const protocol = str(rawServer.protocol);
    const host =
      hostIsTemplate && hostDefault
        ? rawHost.replace(/\{host\}/, hostDefault)
        : rawHost;
    server = {
      key: serverKey!,
      host: rawHost,
      hostIsTemplate,
      hostDefault,
      pathname,
      protocol,
      description: str(rawServer.description),
      url:
        host !== "" && protocol !== undefined
          ? `${protocol}://${host}${pathname ?? ""}`
          : undefined,
    };
    const native = Array.isArray(rawServer.security) ? rawServer.security : [];
    nativeCount = native.length;
    const verbatim = extensionOf(rawServer, "security", prefixes);
    securityKey = verbatim?.key;
    requirements = (
      verbatim !== undefined && Array.isArray(verbatim.value)
        ? verbatim.value.map(readRequirement)
        : native.map((entry) => readNativeRequirement(entry, rawSchemes))
    ).filter(
      (requirement): requirement is WsRequirement => requirement !== null,
    );
  }
  const named = new Set(
    requirements.flatMap((requirement) =>
      requirement.map((part) => part.scheme),
    ),
  );
  const securitySchemes: WsSecurityScheme[] = Object.entries(rawSchemes)
    .filter(([name]) => named.has(name) || named.size === 0)
    .flatMap(([name, scheme]) =>
      isObject(scheme)
        ? [
            {
              name,
              type: str(scheme.type),
              detail: schemeDetail(scheme) || undefined,
              description: str(scheme.description),
              note: str(extensionOf(scheme, "note", prefixes)?.value),
            },
          ]
        : [],
    );

  // Channels: connection first.
  const rawChannels = isObject(doc.channels) ? doc.channels : {};
  const channels: WsChannel[] = Object.entries(rawChannels)
    .flatMap(([key, channel]): WsChannel[] => {
      if (!isObject(channel)) {
        return [];
      }
      const address = str(channel.address) ?? key;
      const declared = isObject(channel.parameters) ? channel.parameters : {};
      const inTemplate = [...address.matchAll(/\{([^}]+)\}/g)].map(
        (match) => match[1],
      );
      const names = [
        ...inTemplate,
        ...Object.keys(declared).filter((name) => !inTemplate.includes(name)),
      ];
      const bindings = isObject(channel.bindings) ? channel.bindings : {};
      const ws = isObject(bindings.ws) ? bindings.ws : {};
      return [
        {
          key,
          slug: itemSlug("channel", key),
          title: str(channel.title) ?? key,
          address,
          description: str(channel.description),
          parameters: names.map((name) => {
            const parameter = isObject(declared[name])
              ? declared[name]
              : undefined;
            const schema = extensionOf(parameter, "schema", prefixes)?.value;
            return {
              name,
              description: str(parameter?.description),
              schema: isObject(schema) ? schema : undefined,
            };
          }),
          messages: messageIds(channel.messages),
          bindingMethod: str(ws.method),
          // The transport: keyed `connection`, or (under another key) the
          // channel carrying the WebSocket binding's upgrade method, which
          // only the socket itself has.
          isConnection: key === "connection" || str(ws.method) !== undefined,
        },
      ];
    })
    .sort((a, b) => Number(b.isConnection) - Number(a.isConnection));
  const connection = channels.find((channel) => channel.isConnection);
  const rawConnection = connection ? (rawChannels[connection.key] as Json) : {};

  // Operations.
  const rawOperations = isObject(doc.operations) ? doc.operations : {};
  const operations: WsOperation[] = Object.entries(rawOperations).flatMap(
    ([key, operation]): WsOperation[] => {
      if (!isObject(operation)) {
        return [];
      }
      const action = str(operation.action);
      const reply = isObject(operation.reply) ? operation.reply : null;
      return [
        {
          key,
          slug: itemSlug("operation", key),
          title: str(operation.title) ?? key,
          summary: str(operation.summary),
          action:
            action === "send" || action === "receive" ? action : undefined,
          channel: refName(operation.channel),
          messages: messageIds(operation.messages),
          reply: reply
            ? {
                channel: refName(reply.channel),
                messages: messageIds(reply.messages),
              }
            : null,
          permission: str(extensionOf(operation, "action", prefixes)?.value),
        },
      ];
    },
  );

  // Messages: control first, then events, each in document order.
  const rawMessages = isObject(components.messages) ? components.messages : {};
  const messages: WsMessage[] = Object.entries(rawMessages)
    .flatMap(([key, message]): WsMessage[] => {
      if (!isObject(message)) {
        return [];
      }
      const examples = Array.isArray(message.examples) ? message.examples : [];
      return [
        {
          key,
          slug: itemSlug("message", key),
          name: str(message.name) ?? key,
          title: str(message.title),
          summary: str(message.summary),
          contentType: str(message.contentType) ?? str(doc.defaultContentType),
          payload: message.payload,
          examples: examples.filter(isObject).map((example) => ({
            name: str(example.name),
            summary: str(example.summary),
            payload: example.payload,
          })),
          event: eventOf(key),
        },
      ];
    })
    .sort((a, b) => Number(a.event !== null) - Number(b.event !== null));

  // The connection's extensions, on the connection channel (or wherever they
  // are): each is read from the first prefix carrying it, looking at the
  // connection channel first.
  const channelExtension = (name: string): FoundExtension | undefined => {
    for (const prefix of prefixes) {
      const key = `${prefix}-${name}`;
      if (Object.hasOwn(rawConnection, key)) {
        return { key, value: rawConnection[key] };
      }
      const carrier = Object.values(rawChannels).find(
        (channel) => isObject(channel) && Object.hasOwn(channel, key),
      );
      if (isObject(carrier)) {
        return { key, value: carrier[key] };
      }
    }
    return undefined;
  };
  const closeCodesExt = channelExtension("close-codes");
  const closeCodes = (
    Array.isArray(closeCodesExt?.value) ? closeCodesExt.value : []
  ).flatMap((entry): WsCloseCode[] =>
    isObject(entry) && num(entry.code) !== undefined
      ? [
          {
            code: num(entry.code)!,
            name: str(entry.name) ?? "",
            description: str(entry.description) ?? "",
          },
        ]
      : [],
  );
  const refusalsExt = channelExtension("upgrade-refusals");
  const refusals = (
    Array.isArray(refusalsExt?.value) ? refusalsExt.value : []
  ).flatMap((entry): WsUpgradeRefusal[] =>
    isObject(entry) && num(entry.status) !== undefined
      ? [
          {
            status: num(entry.status)!,
            code: str(entry.code) ?? "",
            description: str(entry.description) ?? "",
            contentType: str(entry.contentType),
            headers: isObject(entry.headers)
              ? Object.fromEntries(
                  Object.entries(entry.headers).flatMap(([name, value]) =>
                    typeof value === "string" ? [[name, value]] : [],
                  ),
                )
              : {},
          },
        ]
      : [],
  );
  const limitsExt = channelExtension("limits");

  // A non-string extension value is as good as absent (as the original
  // reader's `str(...)` at each level did): fall through to the next source.
  const subprotocolOn = (
    node: Json | undefined,
  ): FoundExtension | undefined => {
    const found = extensionOf(node, "subprotocol", prefixes);
    return found !== undefined && str(found.value) !== undefined
      ? found
      : undefined;
  };
  const onServer = subprotocolOn(rawServer);
  const onConnection =
    onServer === undefined ? subprotocolOn(rawConnection) : undefined;
  const prose =
    onServer === undefined && onConnection === undefined
      ? readSubprotocol(connection?.description)
      : undefined;
  const stated = str(onServer?.value) ?? str(onConnection?.value) ?? prose;
  return {
    title: str(info.title) ?? "WebSocket API",
    version: str(info.version),
    description: str(info.description),
    server,
    subprotocol: {
      value: stated ?? options.defaultSubprotocol,
      fromDocument: stated !== undefined,
      source:
        onServer !== undefined
          ? "server-extension"
          : onConnection !== undefined
            ? "connection-extension"
            : prose !== undefined
              ? "connection-prose"
              : "default",
    },
    subprotocolKey: onServer?.key ?? onConnection?.key,
    extensionKeys: {
      security: securityKey,
      limits: limitsExt?.key,
      closeCodes: closeCodesExt?.key,
      upgradeRefusals: refusalsExt?.key,
    },
    securitySchemes,
    requirements,
    conjunctive: requirements.length > nativeCount,
    channels,
    operations,
    messages,
    limits: readLimits(limitsExt?.value),
    closeCodes,
    refusals,
  };
}

/** One entry of the sidebar. */
export interface WsNavItem {
  /** The item slug. */
  slug: string;
  /** What the entry reads. */
  label: string;
  /** A second line: an address, an action, a summary. */
  hint: string | undefined;
  /** Text the search matches besides the label. */
  keywords: string;
}

/** A sidebar group. */
export interface WsNavGroup {
  /** The group's heading. */
  title: string;
  /** Its entries. */
  items: WsNavItem[];
}

/** The sidebar: the connection's panels, channels, operations, then messages (control, then events). */
export function navGroups(doc: WsDoc): WsNavGroup[] {
  const candidates: (WsNavItem | false | null)[] = [
    doc.limits && {
      slug: itemSlug("limits"),
      label: "Limits",
      hint: doc.extensionKeys.limits,
      keywords: doc.limits.values.map(([name]) => name).join(" "),
    },
    doc.closeCodes.length > 0 && {
      slug: itemSlug("close-codes"),
      label: "Close codes",
      hint: doc.extensionKeys.closeCodes,
      keywords: doc.closeCodes
        .map((entry) => `${entry.code} ${entry.name}`)
        .join(" "),
    },
    doc.refusals.length > 0 && {
      slug: itemSlug("upgrade-refusals"),
      label: "Upgrade refusals",
      hint: doc.extensionKeys.upgradeRefusals,
      keywords: doc.refusals
        .map((entry) => `${entry.status} ${entry.code}`)
        .join(" "),
    },
  ];
  const connection = candidates.filter((item): item is WsNavItem =>
    Boolean(item),
  );
  const control = doc.messages.filter((message) => message.event === null);
  const events = doc.messages.filter((message) => message.event !== null);
  const messageItem = (message: WsMessage): WsNavItem => ({
    slug: message.slug,
    label: message.name,
    hint: message.summary,
    keywords: `${message.title ?? ""} ${message.summary ?? ""}`,
  });
  return [
    { title: "Connection", items: connection },
    {
      title: "Channels",
      items: doc.channels.map((channel) => ({
        slug: channel.slug,
        label: channel.title,
        hint: channel.address,
        keywords: `${channel.key} ${channel.address} ${channel.parameters.map((parameter) => parameter.name).join(" ")}`,
      })),
    },
    {
      title: "Operations",
      items: doc.operations.map((operation) => ({
        slug: operation.slug,
        label: operation.title,
        hint: [operation.action, operation.permission]
          .filter(Boolean)
          .join(" · "),
        keywords: `${operation.key} ${operation.summary ?? ""} ${operation.permission ?? ""}`,
      })),
    },
    { title: "Control messages", items: control.map(messageItem) },
    { title: "Event messages", items: events.map(messageItem) },
  ].filter((group) => group.items.length > 0);
}

/** The groups keeping only entries matching `query` (case-insensitive, every word). */
export function filterGroups(
  groups: readonly WsNavGroup[],
  query: string,
): WsNavGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [...groups];
  }
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => {
        const text =
          `${item.slug} ${item.label} ${item.hint ?? ""} ${item.keywords}`.toLowerCase();
        return words.every((word) => text.includes(word));
      }),
    }))
    .filter((group) => group.items.length > 0);
}

/** What a slug selects. */
export type WsSelection =
  | {
      /** A channel. */
      kind: "channel";
      /** It. */
      channel: WsChannel;
    }
  | {
      /** An operation. */
      kind: "operation";
      /** It. */
      operation: WsOperation;
    }
  | {
      /** A message. */
      kind: "message";
      /** It. */
      message: WsMessage;
    }
  | {
      /** One of the connection's extension panels. */
      kind: "limits" | "close-codes" | "upgrade-refusals";
    };

/** The item a slug names, or `null` when the document has none by it. */
export function selectItem(doc: WsDoc, slug: string): WsSelection | null {
  if (slug === "limits" && doc.limits) {
    return { kind: "limits" };
  }
  if (slug === "close-codes" && doc.closeCodes.length > 0) {
    return { kind: "close-codes" };
  }
  if (slug === "upgrade-refusals" && doc.refusals.length > 0) {
    return { kind: "upgrade-refusals" };
  }
  const channel = doc.channels.find((candidate) => candidate.slug === slug);
  if (channel) {
    return { kind: "channel", channel };
  }
  const operation = doc.operations.find((candidate) => candidate.slug === slug);
  if (operation) {
    return { kind: "operation", operation };
  }
  const message = doc.messages.find((candidate) => candidate.slug === slug);
  return message ? { kind: "message", message } : null;
}

/** The operations on a channel. */
export function operationsOn(doc: WsDoc, channel: string): WsOperation[] {
  return doc.operations.filter((operation) => operation.channel === channel);
}

/** The channels carrying a message. */
export function channelsCarrying(doc: WsDoc, message: string): WsChannel[] {
  return doc.channels.filter((channel) => channel.messages.includes(message));
}

/** The operations sending, receiving or replying with a message. */
export function operationsUsing(doc: WsDoc, message: string): WsOperation[] {
  return doc.operations.filter(
    (operation) =>
      operation.messages.includes(message) ||
      (operation.reply?.messages.includes(message) ?? false),
  );
}

/** The permissions a channel's operations need, de-duplicated, in order. */
export function channelPermissions(doc: WsDoc, channel: string): string[] {
  return [
    ...new Set(
      operationsOn(doc, channel).flatMap((operation) =>
        operation.permission === undefined ? [] : [operation.permission],
      ),
    ),
  ];
}

/**
 * An event message's highlighted part: the schema of `event.payload` inside
 * its envelope (resolving `$ref`s on the way), or `undefined`.
 */
export function eventPayloadSchema(
  payload: unknown,
  root: SpecDocument,
): unknown {
  const deref = (value: unknown): unknown => {
    let current = value;
    for (let i = 0; i < 16 && isObject(current) && str(current.$ref); i++) {
      current = resolveRef(root, str(current.$ref)!);
    }
    return current;
  };
  const envelope = deref(payload);
  const event =
    isObject(envelope) && isObject(envelope.properties)
      ? deref(envelope.properties.event)
      : undefined;
  return isObject(event) && isObject(event.properties)
    ? event.properties.payload
    : undefined;
}

/**
 * An event example's `event.payload` (what the event says), or `undefined`
 * when the frame has none: the part of an event frame the pane shows first.
 */
export function exampleEventPayload(frame: unknown): unknown {
  const event = isObject(frame) ? frame.event : undefined;
  return isObject(event) ? event.payload : undefined;
}
