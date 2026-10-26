/**
 * The AsyncAPI 3.0 generator (AD (e), plan `docs/plans/api-docs-generation/`
 * §5, §11 row (e)): builds a document from a router's WebSocket channels and
 * SSE endpoints — the ones `listRoutes(router)` (bun-validate V12) lists with
 * a `websocket` contract or an SSE body — plus the bare `ws()` routes only
 * `BunWebSocket.wsRoutes()` knows. Discovery and the contract side are V12's
 * (and the socket's listing); this module never re-walks routes itself.
 *
 * What a channel contributes (§5.1):
 *
 * - its address, through `./openapi`'s `toOpenApiPath` (the same path rules:
 *   a wildcard is undocumentable, `:id(\d+)` lifts a `pattern`);
 * - its address parameters, with the schema the upgrade checks carried as
 *   `x-bun-common-schema` (AsyncAPI 3.0 parameters have no `schema` keyword —
 *   bun-jobs' `x-bun-jobs-schema` precedent);
 * - the upgrade's query/headers schemas on `bindings.ws` (the binding's
 *   native fields), its cookies noted in prose;
 * - its messages: inbound rows → `receive` operations (one per message type,
 *   so a declared reply lands on `operation.reply`), outbound rows → one
 *   `send` operation (the implicit `error` frame included). A channel's frame
 *   is the envelope `{ type, id?, data }`, so every message payload is
 *   documented as that envelope (bun-jobs' `eventEnvelope` precedent) with
 *   the declared schema at `data`;
 * - its meta, as the approved extensions: `x-bun-common-subprotocol`,
 *   `x-bun-common-binary`, `x-bun-common-topics`, `x-bun-common-sse-fallback`.
 *
 * A bare `ws()` route (no contract) documents as an honest stub — one
 * unconstrained message each way, with a warning — until
 * `BunWebSocket.describeChannel(path, doc)` declares its messages
 * (`./channelDoc`).
 *
 * An SSE endpoint (a GET route whose contract body is kind `"sse"`) becomes
 * one channel: `bindings.http` with `method: "GET"`, one message per declared
 * event, `x-bun-common-sse: true` — and a channel whose meta names it as
 * `fallback` carries `x-bun-common-sse-fallback` pointing at it (a fallback
 * naming no SSE endpoint of the document is a warning).
 *
 * Brokers are out of scope: the walk keys on the contract's transport name
 * (`"websocket"`, SSE read off an HTTP route's body kind), so a future broker
 * transport maps without a redesign.
 *
 * Lenient (the default) records problems as {@link DocWarning}s and emits
 * what it knows; `strict: "strict"` escalates every warning to a
 * {@link ConfigError}. A duplicate channel id is always a `ConfigError`.
 * Deterministic: two calls over one source deep-equal (plan §9.2).
 */
import type { ContractEntry } from "../contract/describe";
import { isSchema } from "../contract/transport";
import type { BunRouter } from "../BunRouter";
import { BunWebSocket } from "../BunWebSocket";
import { ConfigError } from "../errors";
import type { LoggerLike } from "../logging";
import type { ListedRoute } from "../routeModel";
import type { StandardSchemaV1 } from "../types/standardSchema";
import { listRoutes } from "../routeModel";
import type { WsMessageDoc } from "./channelDoc";
import { channelDocFor } from "./channelDoc";
import type {
  JsonSchemaConverter,
  JsonSchemaLike,
  SchemaDirection,
} from "./convert";
import type { LiftedSchema } from "./lift";
import type { DocWarning } from "./openapi";
import type { OpenApiSecurityScheme } from "./security";
import type { AsyncApiDocument } from "./types";
import { toJsonSchema } from "./convert";
import { liftComponents } from "./lift";
import { toOpenApiPath } from "./openapi";
import { danglingRefs, pruneSchemaComponents } from "./refs";
import { routeDocFor } from "./routeDoc";
import { openApiSecurity, toAsyncApiSecurityScheme } from "./security";

export type { WsChannelDoc, WsMessageDoc } from "./channelDoc";

/**
 * An AsyncAPI 3.0 document, as {@link generateAsyncApi} builds it. Typed
 * loosely on purpose: only the version is pinned, and the document is checked
 * against the official AsyncAPI 3.0.0 schema in the tests.
 */
export type { AsyncApiDocument } from "./types";

/** The WebSocket channel binding version the document declares. */
const WS_BINDING_VERSION = "0.1.0";
/** The HTTP channel binding version (the SSE channels'). */
const HTTP_BINDING_VERSION = "0.3.0";

/** One entry of the walk, handed to {@link AsyncApiOptions.filter}. */
export interface AsyncApiWalkEntry {
  /**
   * What the entry is: `"channel"` — a `websocket` contract's channel
   * (`defineChannel`); `"sse"` — a GET route whose body is server-sent
   * events; `"ws"` — a bare `ws()` route with no contract.
   */
  readonly kind: "channel" | "sse" | "ws";
  /** The route path, as registered. */
  readonly path: string;
}

/** One declared server of the document. */
export interface AsyncApiServerOptions {
  /** The host (and port), e.g. `"localhost:4000"` or a `"{host}"` variable. */
  readonly host: string;
  /** The path the socket is served under. Default `"/"`. */
  readonly pathname?: string;
  /** The protocol. Default `"ws"`. */
  readonly protocol?: string;
  /** Prose for the document. */
  readonly description?: string;
  /** Server variables (`{host}`), and any other AsyncAPI server field. */
  readonly [field: string]: unknown;
}

/** Options for {@link generateAsyncApi}. */
export interface AsyncApiOptions {
  /** `info.title`. Required. */
  title: string;
  /** `info.version`. Required. */
  version: string;
  /** `info.description`, CommonMark. Default: none. */
  description?: string;
  /** The rest of `info` (`contact`, `license`, …). */
  info?: Readonly<Record<string, unknown>>;
  /**
   * `servers`, keyed by name. Default: one `app` server — its host
   * `localhost:<port>` when the source's bound port is known, else a `{host}`
   * variable defaulting to `localhost`; protocol `"ws"`.
   */
  servers?: Readonly<Record<string, AsyncApiServerOptions>>;
  /**
   * Security schemes, in OpenAPI form, mapped with
   * {@link toAsyncApiSecurityScheme} (a browser-unreachable credential's note
   * is appended to the scheme's description). Default: none declared.
   */
  securitySchemes?: Readonly<Record<string, OpenApiSecurityScheme>>;
  /**
   * The security requirement, with OpenAPI's meaning. AsyncAPI 3.0's
   * `server.security` expresses only one scheme per alternative, so a
   * conjunctive requirement (several schemes in one object) is dropped with a
   * warning. Default: with schemes declared, "any one of them".
   */
  security?: readonly Record<string, readonly string[]>[];
  /**
   * Decides which entries are documented. Return `false` to drop one.
   * Default: every entry (a route `.describe({ hidden: true })`d is always
   * left out).
   */
  filter?: (entry: AsyncApiWalkEntry) => boolean;
  /**
   * How hard to be about incomplete documentation.
   * - `"lenient"` (default) — emit what is known, collect the rest in
   *   {@link AsyncApiResult.warnings}.
   * - `"strict"` — throw `ConfigError` on any warning (a bare `ws()` stub
   *   included — declare it with `describeChannel()` first).
   */
  strict?: "lenient" | "strict";
  /**
   * Standard Schema → JSON Schema converters, tried before the built-in
   * registry and keyed by `~standard.vendor`. Default: `{}`.
   */
  converters?: Readonly<Record<string, JsonSchemaConverter>>;
  /**
   * Names a schema so it is emitted once under `components.schemas` and
   * referenced with `$ref` everywhere. Default: a schema's own `$id`/`title`,
   * else inline (plan §4.4).
   */
  componentName?: (
    schema: StandardSchemaV1 | JsonSchemaLike,
  ) => string | undefined;
}

/** What {@link generateAsyncApi} returns. */
export interface AsyncApiResult {
  /** The document. Fresh objects; the caller owns it. */
  document: AsyncApiDocument;
  /**
   * Everything `lenient` mode swallowed: undocumentable paths, bare stubs,
   * unconverted schemas, a fallback naming no SSE endpoint.
   */
  warnings: readonly DocWarning[];
}

/** Whether `value` is a plain object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
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

/** `chat.post` → `ChatPost`, for operation ids and message component keys. */
function pascal(name: string): string {
  return name
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

/** The channel id derived from a path: `/rooms/:room/events` → `roomsByRoomEvents`. */
function channelIdFromPath(path: string): string {
  const words: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "") continue;
    const param = /^[:{](\w+)\}?$/u.exec(segment);
    if (param !== null) {
      words.push("by", param[1]);
      continue;
    }
    const name = segment.replaceAll(/[^\p{L}\p{N}]+/gu, " ").trim();
    for (const word of name.split(" ")) {
      if (word !== "") words.push(word);
    }
  }
  const [first = "channel", ...rest] = words;
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

/** The walk's channel, mid-build. */
interface ChannelBuild {
  /** The channel id (a `channels` key). */
  id: string;
  /** The address template, e.g. `/rooms/{room}`. */
  address: string;
  /** The channel object being built. */
  channel: Record<string, unknown>;
}

/** The SSE body rows of a route, when it is one (a GET whose contract body is kind `"sse"`). */
function sseRowsOf(route: ListedRoute): ContractEntry[] | undefined {
  if (route.method !== "GET" && route.method !== "ALL") return undefined;
  const contract = route.contract;
  if (contract === undefined || contract.transport !== "http") {
    return undefined;
  }
  const rows = contract.entries.filter(
    (entry) =>
      entry.side === "outbound" &&
      entry.part === "body" &&
      entry.kind === "sse",
  );
  return rows.length > 0 ? rows : undefined;
}

/**
 * Builds the AsyncAPI 3.0 document for a router (or adapter) — or for one
 * {@link BunWebSocket}, whose own router is then the route source.
 *
 * @param source  The router/adapter to document, or the socket.
 * @param options See {@link AsyncApiOptions}.
 * @throws ConfigError on a genuine configuration mistake (a duplicate channel
 *   id, a security requirement naming an undeclared scheme), and — under
 *   `strict: "strict"` — on any warning.
 */
export function generateAsyncApi(
  source: BunRouter | BunWebSocket,
  options: AsyncApiOptions,
): AsyncApiResult {
  const strict = options.strict === "strict";
  const warnings: DocWarning[] = [];
  const warn = (
    stage: DocWarning["stage"],
    message: string,
    route?: string,
  ): void => {
    warnings.push({
      stage,
      message,
      ...(route === undefined ? {} : { route }),
    });
  };

  const router = source instanceof BunWebSocket ? source.router : source;
  const socket = source instanceof BunWebSocket ? source : undefined;

  // The contract merges' own warnings (a part refined by an inner layer)
  // become DocWarnings too.
  const collecting: LoggerLike = {
    log: () => {},
    error: () => {},
    warn: (message: unknown, fields?: unknown) => {
      warn(
        "operation",
        fields === undefined
          ? String(message)
          : `${String(message)} ${JSON.stringify(fields)}`,
      );
    },
  };
  const routes = listRoutes(router, { logger: collecting });
  const table = router.routes();

  /* ---------------------------------------------------------------- *
   * Components: every schema goes through toJsonSchema + liftComponents;
   * the lifted components accumulate here, with cross-schema name
   * collisions renamed deterministically (first claim keeps the name) —
   * the OpenAPI generator's own assembly, kept small.
   * ---------------------------------------------------------------- */
  const components = new Map<string, JsonSchemaLike>();
  const claimed = new Map<string, string>(); // name → canonical body

  /** Rewrites `#/components/schemas/<name>` refs through `rename`. */
  const rewriteRefs = (
    node: unknown,
    rename: ReadonlyMap<string, string>,
  ): unknown => {
    if (Array.isArray(node)) {
      return node.map((child) => rewriteRefs(child, rename));
    }
    if (!isPlainObject(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      if (key === "$ref" && typeof child === "string") {
        const prefix = "#/components/schemas/";
        out[key] = child.startsWith(prefix)
          ? (() => {
              const name = child.slice(prefix.length);
              const renamed = rename.get(name);
              return renamed === undefined ? child : `${prefix}${renamed}`;
            })()
          : child;
        continue;
      }
      out[key] = rewriteRefs(child, rename);
    }
    return out;
  };

  const registerBatch = (
    batch: LiftedSchema,
    route: string | undefined,
  ): JsonSchemaLike => {
    const rename = new Map<string, string>();
    const bodies: [string, JsonSchemaLike][] = [];
    for (const [name, body] of Object.entries(batch.components)) {
      const canonical = canonicalJson(body);
      const existing = claimed.get(name);
      if (existing === canonical) {
        continue;
      }
      let finalName = name;
      if (existing !== undefined) {
        let suffix = 2;
        while (
          claimed.has(`${name}${suffix}`) &&
          claimed.get(`${name}${suffix}`) !== canonical
        ) {
          suffix++;
        }
        finalName = `${name}${suffix}`;
        warn(
          "operation",
          `two schemas claimed the component name "${name}"; the later one was renamed "${finalName}"`,
          route,
        );
        rename.set(name, finalName);
      }
      if (!claimed.has(finalName)) {
        claimed.set(finalName, canonical);
        bodies.push([finalName, body]);
      }
    }
    let schema = batch.schema;
    if (rename.size > 0) {
      schema = rewriteRefs(schema, rename) as JsonSchemaLike;
      for (const [index, [name, body]] of bodies.entries()) {
        bodies[index] = [name, rewriteRefs(body, rename) as JsonSchemaLike];
      }
    }
    for (const [name, body] of bodies) {
      components.set(name, body);
    }
    return schema;
  };

  /** Converts one schema and shapes it for the document (see the OpenAPI generator's `emitSchema`). */
  const emitSchema = (
    schema: StandardSchemaV1 | JsonSchemaLike,
    direction: SchemaDirection,
    where: string,
    route: string | undefined,
  ): JsonSchemaLike => {
    let json: JsonSchemaLike;
    if (isSchema(schema)) {
      json = toJsonSchema(schema as StandardSchemaV1, {
        direction,
        ...(options.converters === undefined
          ? {}
          : { converters: options.converters }),
        onWarning: (warning) =>
          warn("operation", `${where}: ${warning.message}`, route),
      });
    } else if (isPlainObject(schema)) {
      json = structuredClone(schema);
    } else {
      warn("operation", `${where}: not a schema; emitted {}`, route);
      json = {};
    }
    const name =
      options.componentName?.(schema) ??
      (typeof json.$id === "string" ? json.$id : undefined) ??
      (typeof json.title === "string" ? json.title : undefined);
    const lifted = liftComponents(json, {
      ...(name === undefined ? {} : { name }),
      onWarning: (warning) =>
        warn("operation", `${where}: ${warning.message}`, route),
    });
    let body = registerBatch(lifted, route);
    if (name !== undefined) {
      if (!(
        typeof body.$ref === "string" &&
        body.$ref.startsWith("#/components/schemas/")
      )) {
        const canonical = canonicalJson(body);
        const existing = claimed.get(name);
        let finalName = name;
        if (existing !== undefined && existing !== canonical) {
          let suffix = 2;
          while (
            claimed.has(`${name}${suffix}`) &&
            claimed.get(`${name}${suffix}`) !== canonical
          ) {
            suffix++;
          }
          finalName = `${name}${suffix}`;
          warn(
            "operation",
            `two schemas claimed the component name "${name}"; the later one was renamed "${finalName}"`,
            route,
          );
        }
        if (!claimed.has(finalName)) {
          claimed.set(finalName, canonical);
          components.set(finalName, body);
        }
        body = { $ref: `#/components/schemas/${finalName}` };
      }
    }
    return body;
  };

  /* ---------------------------------------------------------------- *
   * The channels, messages and operations.
   * ---------------------------------------------------------------- */
  const channels: Record<string, unknown> = {};
  const operations: Record<string, unknown> = {};
  const messages: Record<string, unknown> = {};
  const channelIds = new Map<string, string>(); // id → where it came from
  const operationIds = new Map<string, string>(); // id → where it came from

  const channelMessageRef = (channel: string, type: string) => ({
    $ref: `#/channels/${channel}/messages/${keySafe(type)}`,
  });
  const channelRef = (id: string) => ({ $ref: `#/channels/${id}` });

  /** Claims a channel id, or throws (a duplicate channel id is always a ConfigError). */
  const claimChannelId = (id: string, where: string): string => {
    const safe = keySafe(id);
    const existing = channelIds.get(safe);
    if (existing !== undefined) {
      throw new ConfigError(
        `Two channels share the id "${safe}" (${existing} and ${where})`,
        { channelId: safe, first: existing, second: where },
      );
    }
    channelIds.set(safe, where);
    return safe;
  };

  /** Claims an operation id, or throws. */
  const claimOperationId = (id: string, where: string): string => {
    const safe = keySafe(id);
    const existing = operationIds.get(safe);
    if (existing !== undefined) {
      throw new ConfigError(
        `Two operations share the id "${safe}" (${existing} and ${where})`,
        { operationId: safe, first: existing, second: where },
      );
    }
    operationIds.set(safe, where);
    return safe;
  };

  /** Registers one message in `components.messages` and links it from its channel. */
  const registerMessage = (
    build: ChannelBuild,
    type: string,
    message: Record<string, unknown>,
  ): void => {
    const key = `${build.id}.${keySafe(type)}`;
    messages[key] = message;
    (build.channel.messages as Record<string, unknown>)[keySafe(type)] = {
      $ref: `#/components/messages/${key}`,
    };
  };

  /** The parameters of an address, from the upgrade's params schema where there is one. */
  const parametersOf = (
    templateParams: readonly { name: string; pattern?: string }[],
    paramsSchema: StandardSchemaV1 | undefined,
    where: string,
  ): Record<string, unknown> | undefined => {
    if (templateParams.length === 0) return undefined;
    const properties: Record<string, unknown> = {};
    if (paramsSchema !== undefined) {
      const json = emitSchema(paramsSchema, "input", `${where} params`, where);
      if (isPlainObject(json.properties)) {
        Object.assign(properties, json.properties);
      }
    }
    return Object.fromEntries(
      templateParams.map((param) => {
        const given = isPlainObject(properties[param.name])
          ? (properties[param.name] as JsonSchemaLike)
          : undefined;
        let schema: JsonSchemaLike = given ?? { type: "string" };
        if (param.pattern !== undefined && schema.pattern === undefined) {
          schema = { ...schema, pattern: param.pattern };
        }
        return [
          param.name,
          {
            ...(typeof schema.description === "string"
              ? { description: schema.description }
              : {}),
            // AsyncAPI 3.0 parameters carry no schema keyword (bun-jobs'
            // x-bun-jobs-schema precedent).
            "x-bun-common-schema": schema,
          },
        ];
      }),
    );
  };

  /** The address of a path, or `undefined` (warned) when it cannot be expressed. */
  const addressOf = (
    path: string,
    where: string,
  ):
    | {
        address: string;
        params: readonly { name: string; pattern?: string }[];
      }
    | undefined => {
    const result = toOpenApiPath(path, { optionalParams: "warn" });
    for (const message of result.warnings) {
      warn("path", message, where);
    }
    if (result.undocumentable !== undefined) {
      warn(
        "path",
        `${path}: ${result.undocumentable} — the entry is left out of the document`,
        where,
      );
      return undefined;
    }
    const template = result.templates[0];
    return { address: template.path, params: template.params };
  };

  /** The rows of one side of a channel contract, type → its data row. */
  const rowsByType = (
    route: ListedRoute,
    side: "inbound" | "outbound",
  ): [string, ContractEntry][] => {
    const keys = route.contract?.sides[side]?.keys ?? [];
    const entries = (route.contract?.entries ?? []).filter(
      (entry) => entry.side === side,
    );
    return keys
      .map(
        (key) =>
          [
            key,
            entries.find((entry) => entry.key === key && entry.part === "data"),
          ] as [string, ContractEntry | undefined],
      )
      .filter((pair): pair is [string, ContractEntry] => pair[1] !== undefined);
  };

  /** The envelope one channel message travels in: `{ type, id?, data }`. */
  const envelopePayload = (
    type: string,
    idField: string,
    data: JsonSchemaLike | null,
  ): JsonSchemaLike => ({
    type: "object",
    properties: {
      type: { const: type, description: "The message type." },
      [idField]: {
        type: "string",
        description:
          "The correlation id: present on a message expecting a reply, and echoed by it.",
      },
      ...(data === null ? {} : { data }),
    },
    required: ["type", ...(data === null ? [] : ["data"])],
  });

  /**
   * One contract channel (a listed route whose contract's transport is
   * `"websocket"`).
   */
  const buildContractChannel = (route: ListedRoute): void => {
    const contract = route.contract!;
    const meta = contract.meta.channel;
    const where = route.key;
    const addressed = addressOf(route.path, where);
    if (addressed === undefined) return;
    const request = meta?.request;
    const idField = meta?.envelope.idField ?? "id";

    const id = claimChannelId(
      meta !== undefined &&
        contract.meta.name !== undefined &&
        contract.meta.name !== meta.path
        ? contract.meta.name
        : channelIdFromPath(route.path),
      where,
    );

    const prose: string[] = [];
    if (contract.meta.description !== undefined) {
      prose.push(contract.meta.description);
    }
    prose.push(
      `Frames are JSON envelopes \`{ "type": "<type>", "${idField}"?: string, "data": … }\`.`,
    );
    if (
      request?.cookies !== undefined ||
      request?.signedCookies !== undefined
    ) {
      prose.push(
        "The upgrade request also validates cookies (sent in the `Cookie` header, as any HTTP request's).",
      );
    }

    const parameters = parametersOf(addressed.params, request?.params, where);
    const build: ChannelBuild = {
      id,
      address: addressed.address,
      channel: {
        address: addressed.address,
        ...(contract.meta.name === undefined
          ? {}
          : { title: contract.meta.name }),
        description: prose.join("\n\n"),
        ...(parameters === undefined ? {} : { parameters }),
        messages: {},
        bindings: {
          ws: {
            method: "GET",
            ...(request?.query === undefined
              ? {}
              : {
                  query: emitSchema(
                    request.query,
                    "input",
                    `${where} query`,
                    where,
                  ),
                }),
            ...(request?.headers === undefined
              ? {}
              : {
                  headers: emitSchema(
                    request.headers,
                    "input",
                    `${where} headers`,
                    where,
                  ),
                }),
            bindingVersion: WS_BINDING_VERSION,
          },
        },
      },
    };

    const inbound = rowsByType(route, "inbound");
    const outbound = rowsByType(route, "outbound");
    const replies = meta?.replies ?? {};

    for (const [type, row] of inbound) {
      registerMessage(build, type, {
        name: type,
        contentType: "application/json",
        payload: envelopePayload(
          type,
          idField,
          row.schema === null
            ? null
            : emitSchema(
                row.schema,
                "input",
                `${where} message "${type}"`,
                where,
              ),
        ),
      });
    }
    for (const [type, row] of outbound) {
      registerMessage(build, type, {
        name: type,
        contentType: "application/json",
        // The implicit error frame (channelContract's own declaration, a
        // `documented()` schema) is marked as the framework's, not the app's.
        ...(type === "error" && row.vendor === "bun-common/documented"
          ? {
              summary:
                "Declared by the framework (the channel's implicit error frame), not by the application.",
            }
          : row.implicit === true
            ? {
                summary: "Declared by the framework, not by the application.",
              }
            : {}),
        payload: envelopePayload(
          type,
          idField,
          row.schema === null
            ? null
            : emitSchema(
                row.schema,
                "input",
                `${where} message "${type}"`,
                where,
              ),
        ),
      });
    }

    for (const [type] of inbound) {
      const replyType = replies[type];
      if (replyType !== undefined && !outbound.some(([t]) => t === replyType)) {
        warn(
          "operation",
          `the reply "${replyType}" of "${type}" is not a declared outbound message — the reply link was left out`,
          where,
        );
      }
      operations[
        claimOperationId(`receive${pascal(id)}${pascal(type)}`, where)
      ] = {
        action: "receive",
        channel: channelRef(id),
        messages: [channelMessageRef(id, type)],
        ...(replyType !== undefined && outbound.some(([t]) => t === replyType)
          ? {
              reply: {
                channel: channelRef(id),
                messages: [channelMessageRef(id, replyType)],
              },
            }
          : {}),
      };
    }
    if (outbound.length > 0) {
      operations[claimOperationId(`send${pascal(id)}`, where)] = {
        action: "send",
        channel: channelRef(id),
        messages: outbound.map(([type]) => channelMessageRef(id, type)),
      };
    }

    /* The meta, as the approved extensions. */
    if (meta?.subprotocol !== undefined) {
      build.channel["x-bun-common-subprotocol"] = meta.subprotocol;
    }
    if (meta?.binary === true) {
      build.channel["x-bun-common-binary"] = true;
    }
    if (meta?.topics !== undefined) {
      build.channel["x-bun-common-topics"] = [...meta.topics];
    }
    if (meta?.fallback !== undefined) {
      build.channel["x-bun-common-sse-fallback"] = meta.fallback;
    }
    channels[id] = build.channel;
  };

  /**
   * One SSE channel (a GET route whose contract body is kind `"sse"`): one
   * message per declared event, the payload the event's data (no envelope —
   * each `data:` line carries one event's data).
   */
  const buildSseChannel = (
    route: ListedRoute,
    rows: ContractEntry[],
    doc: ReturnType<typeof routeDocFor>,
  ): void => {
    const where = route.key;
    const addressed = addressOf(route.path, where);
    if (addressed === undefined) return;
    const id = claimChannelId(channelIdFromPath(route.path), where);

    const paramsRow = route.contract?.entries.find(
      (entry) => entry.side === "inbound" && entry.part === "params",
    );
    const parameters = parametersOf(
      addressed.params,
      paramsRow?.schema ?? undefined,
      where,
    );

    const build: ChannelBuild = {
      id,
      address: addressed.address,
      channel: {
        address: addressed.address,
        ...(doc?.summary === undefined ? {} : { title: doc.summary }),
        description: [
          doc?.description,
          "Server-sent events (a `text/event-stream` GET): each event arrives as `event:`/`data:` lines, the `data:` carrying one event's data.",
        ]
          .filter((part): part is string => typeof part === "string")
          .join("\n\n"),
        ...(parameters === undefined ? {} : { parameters }),
        messages: {},
        bindings: {
          http: { method: "GET", bindingVersion: HTTP_BINDING_VERSION },
        },
        "x-bun-common-sse": true,
      },
    };

    /** The events: [name, its data row, its parent SSE row (for the media type)]. */
    const events: [string, ContractEntry, ContractEntry][] = [];
    for (const row of rows) {
      for (const nested of row.nested ?? []) {
        if (nested.part !== "data") continue;
        events.push([nested.key ?? "message", nested, row]);
      }
    }
    const direction: SchemaDirection =
      route.responseOutput === "parsed" ? "output" : "input";
    for (const [event, nested, parent] of events) {
      registerMessage(build, event, {
        name: event,
        contentType:
          (parent.schema as { data?: unknown } | null)?.data === "text"
            ? "text/plain"
            : "application/json",
        // A `null` data schema: the event carries no data (no `payload`).
        ...(nested.schema === null
          ? {}
          : {
              payload: emitSchema(
                nested.schema,
                direction,
                `${where} event "${event}"`,
                where,
              ),
            }),
      });
    }
    if (events.length > 0) {
      operations[claimOperationId(`send${pascal(id)}`, where)] = {
        action: "send",
        channel: channelRef(id),
        messages: events.map(([event]) => channelMessageRef(id, event)),
      };
    }
    channels[id] = build.channel;
  };

  /**
   * One bare `ws()` route (no contract): the honest stub, enriched by a
   * `describeChannel()` doc when one exists.
   */
  const buildBareChannel = (sock: BunWebSocket, path: string): void => {
    const where = `WS ${path}`;
    const addressed = addressOf(path, where);
    if (addressed === undefined) return;
    const doc = channelDocFor(sock, path);
    if (doc === undefined) {
      warn(
        "operation",
        "a bare ws() route carries no message declarations; it documents as a stub (one unconstrained message each way) — declare its messages with describeChannel()",
        where,
      );
    }
    const id = claimChannelId(channelIdFromPath(path), where);
    const build: ChannelBuild = {
      id,
      address: addressed.address,
      channel: {
        address: addressed.address,
        title: doc?.title ?? path,
        ...(doc?.description === undefined
          ? {}
          : { description: doc.description }),
        ...(parametersOf(addressed.params, undefined, where) === undefined
          ? {}
          : { parameters: parametersOf(addressed.params, undefined, where) }),
        messages: {},
        bindings: {
          ws: { method: "GET", bindingVersion: WS_BINDING_VERSION },
        },
      },
    };

    /** One declared (or stub) message; a bare route's payload is the frame itself, no envelope. */
    const docMessage = (
      type: string,
      messageDoc: WsMessageDoc | undefined,
      direction: "client → server" | "server → client",
    ): Record<string, unknown> => ({
      name: type,
      ...(messageDoc?.summary === undefined
        ? doc === undefined
          ? {
              summary: `A ${direction} frame; the shape is the application's (nothing is declared — describeChannel() documents it).`,
            }
          : {}
        : { summary: messageDoc.summary }),
      contentType: messageDoc?.contentType ?? "application/json",
      payload:
        messageDoc?.payload === undefined
          ? {}
          : emitSchema(
              messageDoc.payload,
              "input",
              `${where} message "${type}"`,
              where,
            ),
      ...(messageDoc?.examples === undefined
        ? {}
        : {
            examples: Object.entries(messageDoc.examples).map(
              ([name, payload]) => ({ name, payload }),
            ),
          }),
    });

    const receives = Object.entries(doc?.receives ?? { incoming: {} });
    const sends = Object.entries(doc?.sends ?? { outgoing: {} });
    for (const [type, messageDoc] of receives) {
      registerMessage(
        build,
        type,
        docMessage(type, messageDoc, "client → server"),
      );
    }
    for (const [type, messageDoc] of sends) {
      registerMessage(
        build,
        type,
        docMessage(type, messageDoc, "server → client"),
      );
    }
    const sendTypes = new Map(sends);
    for (const [type, messageDoc] of receives) {
      const replyType = messageDoc?.reply;
      if (replyType !== undefined && !sendTypes.has(replyType)) {
        warn(
          "operation",
          `the reply "${replyType}" of "${type}" is not a declared sent message — the reply link was left out`,
          where,
        );
      }
      operations[
        claimOperationId(`receive${pascal(id)}${pascal(type)}`, where)
      ] = {
        action: "receive",
        channel: channelRef(id),
        messages: [channelMessageRef(id, type)],
        ...(replyType !== undefined && sendTypes.has(replyType)
          ? {
              reply: {
                channel: channelRef(id),
                messages: [channelMessageRef(id, replyType)],
              },
            }
          : {}),
      };
    }
    if (sends.length > 0) {
      operations[claimOperationId(`send${pascal(id)}`, where)] = {
        action: "send",
        channel: channelRef(id),
        messages: sends.map(([type]) => channelMessageRef(id, type)),
      };
    }
    if (doc?.subprotocol !== undefined) {
      build.channel["x-bun-common-subprotocol"] = doc.subprotocol;
    }
    channels[id] = build.channel;
  };

  /* ---------------------------------------------------------------- *
   * The walk.
   * ---------------------------------------------------------------- */
  const coveredPaths = new Set<string>();
  for (const route of routes) {
    const terminal = (
      table[route.routeIndex] as { callbacks?: unknown[] } | undefined
    )?.callbacks?.at(-1);
    const doc = routeDocFor(terminal);
    if (doc?.hidden === true) continue;

    if (
      route.contract !== undefined &&
      route.contract.transport === "websocket"
    ) {
      if (
        options.filter !== undefined &&
        !options.filter({ kind: "channel", path: route.path })
      ) {
        continue;
      }
      if (route.partial === true) {
        warn(
          "operation",
          "no concrete request path could be synthesized for this route (a regex constraint or host scope), so the middleware before it was not replayed; the document uses the route's own callbacks alone",
          route.key,
        );
      }
      buildContractChannel(route);
      coveredPaths.add(route.path);
      continue;
    }
    const sseRows = sseRowsOf(route);
    if (sseRows !== undefined) {
      if (
        options.filter !== undefined &&
        !options.filter({ kind: "sse", path: route.path })
      ) {
        continue;
      }
      buildSseChannel(route, sseRows, doc);
    }
  }

  /* The bare ws() routes, from the socket's own listing. */
  const socketInstance =
    socket ?? (router.getBunWebsocket() as BunWebSocket | undefined);
  if (socketInstance !== undefined) {
    for (const listed of socketInstance.wsRoutes()) {
      if (coveredPaths.has(listed.path)) {
        if (channelDocFor(socketInstance, listed.path) !== undefined) {
          warn(
            "operation",
            "describeChannel() on a channel that documents itself (a defineChannel contract) is ignored",
            `WS ${listed.path}`,
          );
        }
        continue;
      }
      if (
        options.filter !== undefined &&
        !options.filter({ kind: "ws", path: listed.path })
      ) {
        continue;
      }
      buildBareChannel(socketInstance, listed.path);
      coveredPaths.add(listed.path);
    }
  }

  /* The fallback cross-references: a channel's x-bun-common-sse-fallback must
   * name an SSE channel of this document. */
  const sseAddresses = new Set(
    Object.values(channels)
      .filter(
        (channel) =>
          (channel as Record<string, unknown>)["x-bun-common-sse"] === true,
      )
      .map((channel) => (channel as { address: string }).address),
  );
  for (const [id, channel] of Object.entries(channels)) {
    const fallback = (channel as Record<string, unknown>)[
      "x-bun-common-sse-fallback"
    ];
    if (typeof fallback !== "string") continue;
    const addressed = addressOf(fallback, `channel ${id}`);
    if (addressed === undefined) continue;
    if (!sseAddresses.has(addressed.address)) {
      warn(
        "operation",
        `the SSE fallback "${fallback}" names no SSE endpoint of this document`,
        `channel ${id}`,
      );
    }
  }

  /* ---------------------------------------------------------------- *
   * Security (the OpenAPI declarations, mapped). AsyncAPI 3.0's
   * `server.security` expresses one scheme per alternative, so a
   * conjunctive requirement is dropped with a warning.
   * ---------------------------------------------------------------- */
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
          "security",
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

  /* ---------------------------------------------------------------- *
   * The document.
   * ---------------------------------------------------------------- */
  // The bound port of the socket's server, when it is known (a shared server
  // that has not started listening yet has none).
  const port = socketInstance?.port;
  const servers: Record<string, unknown> =
    options.servers === undefined
      ? {
          app: {
            host: port === undefined ? "{host}" : `localhost:${port}`,
            pathname: "/",
            protocol: "ws",
            ...(port === undefined
              ? {
                  variables: {
                    host: {
                      default: "localhost",
                      description:
                        "The host (and port) the socket is served on; the bound port is unknown until the server listens.",
                    },
                  },
                }
              : {}),
            ...(serverSecurity.length > 0 ? { security: serverSecurity } : {}),
          },
        }
      : Object.fromEntries(
          Object.entries(options.servers).map(([name, server]) => [
            name,
            {
              protocol: "ws",
              pathname: "/",
              ...structuredClone(server),
              ...(serverSecurity.length > 0
                ? { security: serverSecurity }
                : {}),
            },
          ]),
        );

  const document: AsyncApiDocument = {
    asyncapi: "3.0.0",
    info: {
      title: options.title,
      version: options.version,
      ...(options.description === undefined
        ? {}
        : { description: options.description }),
      ...(options.info === undefined ? {} : { ...options.info }),
    },
    defaultContentType: "application/json",
    servers,
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

  pruneSchemaComponents(
    document as unknown as Parameters<typeof pruneSchemaComponents>[0],
  );
  const dangling = danglingRefs(document);
  if (dangling.length > 0) {
    warn(
      "operation",
      `the document has ${dangling.length} dangling $ref(s): ${dangling.join(", ")}`,
    );
  }

  if (strict && warnings.length > 0) {
    throw new ConfigError(
      `generateAsyncApi() in strict mode: ${warnings.length} warning(s):\n${warnings
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
