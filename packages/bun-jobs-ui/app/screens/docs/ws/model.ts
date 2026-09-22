import type { SpecDocument } from "../../../api/docs";
import type { EventName, JobsApiMode } from "../../../api/types";
import {
  encodeJobId,
  JOBS_API_ACTIONS,
  JOBS_API_WS_SUBPROTOCOL,
  MAX_NAME_LENGTH,
  NAME_PARAM_PATTERN,
} from "@kingsleyweb/bun-jobs/api/contract";
import { parseChannel, typesFor } from "../../events/eventLog";
import { resolveRef } from "../schema/resolve";

/**
 * The WebSocket reference's pure half: the AsyncAPI 3.0 document read into
 * what the screen shows (header, sidebar items, per-item detail, the
 * `x-bun-jobs-*` extensions), and the "try it" links into the Events console.
 *
 * Everything is read defensively: the document is JSON from the server, and a
 * field this reader does not find is left out rather than guessed.
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
  return `/docs/ws/${encodeURIComponent(slug)}${query ? `?${new URLSearchParams({ q: query }).toString()}` : ""}`;
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
   * The value's JSON Schema, from the `x-bun-jobs-schema` extension (AsyncAPI
   * 3.0's Parameter Object has no `schema` field); `undefined` when the
   * document gives none (a job id, or an older API).
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
  /** The permission it needs (`x-bun-jobs-action`). */
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
  /** For an event message: its kind and type (`queue`, `completed`); `null` for a control message. */
  event: {
    /** `queue`, `runner` or `worker`. */
    kind: "queue" | "runner" | "worker";
    /** The event type. */
    type: EventName;
  } | null;
}

/** One `x-bun-jobs-close-codes` entry. */
export interface WsCloseCode {
  /** The close code. */
  code: number;
  /** Its name. */
  name: string;
  /** When it is sent. */
  description: string;
}

/** One `x-bun-jobs-upgrade-refusals` entry. */
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

/** `x-bun-jobs-limits`, as far as it was found. */
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
  /** What a browser WebSocket cannot carry (`x-bun-jobs-note`). */
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
    /** The subprotocol. */
    value: string;
    /** Whether it was read from the document rather than assumed. */
    fromDocument: boolean;
    /**
     * Where it came from: the `x-bun-jobs-subprotocol` extension on the
     * server (`servers.api`, see {@link WsServer.key}), else on the
     * connection channel; the connection channel's description (an older
     * API that stated it only there); or the client contract's constant when
     * the document says nothing. {@link subprotocolSource} words it.
     */
    source:
      | "server-extension"
      | "connection-extension"
      | "connection-prose"
      | "contract";
  };
  /** Declared schemes that a requirement names. */
  securitySchemes: WsSecurityScheme[];
  /** Every requirement (`x-bun-jobs-security`, else the native list): any one suffices. */
  requirements: WsRequirement[];
  /** Whether some requirement could not be expressed in the native `security` list (it names several schemes). */
  conjunctive: boolean;
  /** Channels: `connection` first, then the families in document order. */
  channels: WsChannel[];
  /** Operations, in document order. */
  operations: WsOperation[];
  /** Messages: control messages, then events. */
  messages: WsMessage[];
  /** `x-bun-jobs-limits`, or `null` when absent. */
  limits: WsLimits | null;
  /** `x-bun-jobs-close-codes`. */
  closeCodes: WsCloseCode[];
  /** `x-bun-jobs-upgrade-refusals`. */
  refusals: WsUpgradeRefusal[];
}

/**
 * Where the subprotocol shown was read from, in words: `from servers.api
 * (x-bun-jobs-subprotocol)`, `from the connection channel
 * (x-bun-jobs-subprotocol)`, `from the connection channel's description`, or
 * `not stated; the client default`.
 */
export function subprotocolSource(doc: WsDoc): string {
  switch (doc.subprotocol.source) {
    case "server-extension":
      return `from servers.${doc.server?.key ?? "api"} (x-bun-jobs-subprotocol)`;
    case "connection-extension":
      return "from the connection channel (x-bun-jobs-subprotocol)";
    case "connection-prose":
      return "from the connection channel's description";
    case "contract":
      return "not stated; the client default";
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

/** Reads the event kind and type from a message key (`queue.completed`). */
function eventOf(key: string): WsMessage["event"] {
  const match = /^(queue|runner|worker)\.(.+)$/.exec(key);
  return match
    ? {
        kind: match[1] as NonNullable<WsMessage["event"]>["kind"],
        type: match[2] as EventName,
      }
    : null;
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
export function readWsDoc(doc: SpecDocument): WsDoc {
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
    const verbatim = rawServer["x-bun-jobs-security"];
    requirements = (
      Array.isArray(verbatim)
        ? verbatim.map(readRequirement)
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
              note: str(scheme["x-bun-jobs-note"]),
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
        (match) => match[1]!,
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
            const schema = parameter?.["x-bun-jobs-schema"];
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
          permission: str(operation["x-bun-jobs-action"]),
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

  // The extensions, on the connection channel (or wherever they are).
  const extension = (name: string): unknown =>
    rawConnection[name] ??
    Object.values(rawChannels).find(
      (channel) => isObject(channel) && channel[name] !== undefined,
    )?.[name as never];
  const closeCodes = (
    Array.isArray(extension("x-bun-jobs-close-codes"))
      ? (extension("x-bun-jobs-close-codes") as unknown[])
      : []
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
  const refusals = (
    Array.isArray(extension("x-bun-jobs-upgrade-refusals"))
      ? (extension("x-bun-jobs-upgrade-refusals") as unknown[])
      : []
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

  const onServer = str(rawServer?.["x-bun-jobs-subprotocol"]);
  const onConnection =
    onServer === undefined
      ? str(rawConnection["x-bun-jobs-subprotocol"])
      : undefined;
  const prose =
    onServer === undefined && onConnection === undefined
      ? readSubprotocol(connection?.description)
      : undefined;
  const stated = onServer ?? onConnection ?? prose;
  return {
    title: str(info.title) ?? "WebSocket API",
    version: str(info.version),
    description: str(info.description),
    server,
    subprotocol: {
      value: stated ?? JOBS_API_WS_SUBPROTOCOL,
      fromDocument: stated !== undefined,
      source:
        onServer !== undefined
          ? "server-extension"
          : onConnection !== undefined
            ? "connection-extension"
            : prose !== undefined
              ? "connection-prose"
              : "contract",
    },
    securitySchemes,
    requirements,
    conjunctive: requirements.length > nativeCount,
    channels,
    operations,
    messages,
    limits: readLimits(extension("x-bun-jobs-limits")),
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
      hint: "x-bun-jobs-limits",
      keywords: doc.limits.values.map(([name]) => name).join(" "),
    },
    doc.closeCodes.length > 0 && {
      slug: itemSlug("close-codes"),
      label: "Close codes",
      hint: "x-bun-jobs-close-codes",
      keywords: doc.closeCodes
        .map((entry) => `${entry.code} ${entry.name}`)
        .join(" "),
    },
    doc.refusals.length > 0 && {
      slug: itemSlug("upgrade-refusals"),
      label: "Upgrade refusals",
      hint: "x-bun-jobs-upgrade-refusals",
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

/** Whether a string is one of the API's actions (so a have/lack marker can be shown). */
export function isKnownAction(
  action: string,
): action is (typeof JOBS_API_ACTIONS)[number] {
  return (JOBS_API_ACTIONS as readonly string[]).includes(action);
}

/** The event types a channel carries (`completed`, ...), de-duplicated, in order. */
export function channelEventTypes(doc: WsDoc, channel: WsChannel): EventName[] {
  const types = channel.messages.flatMap((key) => {
    const message = doc.messages.find((candidate) => candidate.key === key);
    return message?.event ? [message.event.type] : [];
  });
  return [...new Set(types)];
}

/** How a queue or runner name must look (the contract's `NAME_PARAM_PATTERN`). */
const NAME_PATTERN = new RegExp(NAME_PARAM_PATTERN);

/** Why a name is refused under the contract's rule, for an API that documents none. */
const NAME_PROBLEM = `Letters, digits, "_", "." and "-" only (not "." or ".."), at most ${MAX_NAME_LENGTH}.`;

/** Compiles a JSON Schema `pattern` (ECMA-262, unicode), or `undefined` when it does not compile. */
function compilePattern(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern, "u");
  } catch {
    return undefined;
  }
}

/**
 * Why a value is refused by a parameter's `x-bun-jobs-schema` (its
 * `pattern`, `minLength` and `maxLength`; lengths in code points, as JSON
 * Schema counts them), or `null` when it passes. A pattern that does not
 * compile is skipped rather than refusing everything.
 */
function schemaProblem(schema: Json, value: string): string | null {
  const length = [...value].length;
  const max = num(schema.maxLength);
  if (max !== undefined && length > max) {
    return `At most ${max} characters (this is ${length}).`;
  }
  const min = num(schema.minLength);
  if (min !== undefined && length < min) {
    return `At least ${min} characters.`;
  }
  const pattern = str(schema.pattern);
  const compiled = pattern === undefined ? undefined : compilePattern(pattern);
  if (compiled && !compiled.test(value)) {
    return pattern === NAME_PARAM_PATTERN
      ? `Letters, digits, "_", "." and "-" only (not "." or "..").`
      : `Must match ${pattern}.`;
  }
  return null;
}

/**
 * Why a parameter value is refused, or `null` when it is fine (or empty).
 * The document's `x-bun-jobs-schema` decides when it gives one; otherwise a
 * job id is anything (it is escaped) and any other parameter is held to the
 * contract's name rule, for an API older than the extension.
 */
export function parameterProblem(
  name: string,
  value: string,
  schema?: Json,
): string | null {
  if (value === "") {
    return null;
  }
  if (schema !== undefined) {
    return schemaProblem(schema, value);
  }
  if (name === "jobId") {
    return null;
  }
  return value.length <= MAX_NAME_LENGTH && NAME_PATTERN.test(value)
    ? null
    : NAME_PROBLEM;
}

/** The parameters' schemas by name, for {@link fillAddress}. */
export function parameterSchemas(
  parameters: readonly WsParameter[],
): Record<string, Json | undefined> {
  return Object.fromEntries(
    parameters.map((parameter) => [parameter.name, parameter.schema]),
  );
}

/**
 * An address template filled from parameter values: `queue/{queue}/job/{jobId}`
 * with the job id escaped by the contract's `encodeJobId`, exactly as the
 * live client names job channels (`liveChannels.job`). `null` while a value
 * is missing or refused by {@link parameterProblem} (under `schemas`, the
 * document's, when it gives them).
 */
export function fillAddress(
  address: string,
  values: Readonly<Record<string, string>>,
  schemas: Readonly<Record<string, Json | undefined>> = {},
): string | null {
  let complete = true;
  const filled = address.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = values[name] ?? "";
    if (value === "" || parameterProblem(name, value, schemas[name]) !== null) {
      complete = false;
      return "";
    }
    return name === "jobId" ? encodeJobId(value) : value;
  });
  return complete ? filled : null;
}

/**
 * Why a channel's try-it cannot be opened yet: each empty or refused
 * parameter, in template order. Empty when it can.
 */
export function tryProblems(
  channel: WsChannel,
  values: Readonly<Record<string, string>>,
): string[] {
  return channel.parameters.flatMap((parameter) => {
    const value = values[parameter.name] ?? "";
    if (value === "") {
      return [`${parameter.name}: fill it in.`];
    }
    const problem = parameterProblem(parameter.name, value, parameter.schema);
    return problem === null ? [] : [`${parameter.name}: ${problem}`];
  });
}

/**
 * The Events console link subscribing to `channel` filtered to `types`, or
 * `null` when the console could not open it in `mode`. The type filter is
 * left off when it would let every type the console offers for the channel
 * through anyway (a filter of everything is no filter).
 */
export function eventsLink(
  channel: string,
  types: readonly EventName[],
  mode: JobsApiMode,
): string | null {
  const choice = parseChannel(channel, mode);
  if (choice === null) {
    return null;
  }
  const allowed = typesFor(choice);
  const kept = allowed.filter((type) => types.includes(type));
  const params = new URLSearchParams({ channel });
  if (kept.length > 0 && kept.length < allowed.length) {
    params.set("types", kept.join(","));
  }
  return `/events?${params.toString()}`;
}

/**
 * Whether a channel is something to subscribe to, and so has a try-it at
 * all: a logical channel name. The connection is the transport the others
 * travel over, and an address that is a socket path (`/...`) is not a
 * channel name either; neither gets a try-it, not even a disabled one.
 */
export function channelSubscribable(channel: WsChannel): boolean {
  return !channel.isConnection && !channel.address.startsWith("/");
}

/**
 * The console link for a channel family: its address filled from `values`
 * and the types it carries. `null` while the address is incomplete, or for
 * a channel that is not {@link channelSubscribable}.
 */
export function channelTryLink(
  doc: WsDoc,
  channel: WsChannel,
  values: Readonly<Record<string, string>>,
  mode: JobsApiMode,
): string | null {
  if (!channelSubscribable(channel)) {
    return null;
  }
  const address = fillAddress(
    channel.address,
    values,
    parameterSchemas(channel.parameters),
  );
  return address === null
    ? null
    : eventsLink(address, channelEventTypes(doc, channel), mode);
}

/**
 * The console link for an event message: its kind's broad channel
 * (`queues` / `runners`) when the document has it, else `all`, filtered to
 * the one type. `null` for a control message.
 */
export function messageTryLink(
  doc: WsDoc,
  message: WsMessage,
  mode: JobsApiMode,
): string | null {
  if (message.event === null) {
    return null;
  }
  // Each kind's broad channel. Worker events are off `all` and `queues`, so
  // `workers` is the only one that carries them.
  const broad =
    message.event.kind === "queue"
      ? "queues"
      : message.event.kind === "worker"
        ? "workers"
        : "runners";
  const channel = [broad, "all"].find((key) =>
    doc.channels.some((candidate) => candidate.key === key),
  );
  if (channel === undefined) {
    return null;
  }
  const params = new URLSearchParams({ channel, types: message.event.type });
  return parseChannel(channel, mode) === null
    ? null
    : `/events?${params.toString()}`;
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
